import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { redact } from './redact.js';

export const SESSIONS_DIR = join(homedir(), '.claude', 'projects');

const MAX_TOOL_INPUT = 400;
const HUMAN_ORIGINS = new Set(['human', 'channel']);

// Only tools that changed something or ran a command are worth keeping. Read-only
// lookups and MCP chatter are the bulk of the calls and carry no signal about the work.
const MUTATING_TOOLS = new Set(['Bash', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export interface CodeBlock {
  position: number;
  type: 'text' | 'thinking' | 'tool_use';
  text: string | null;
  toolUseId: string | null;
  toolName: string | null;
  toolInputJson: string | null;
}

export interface CodeMessage {
  uuid: string;
  idx: number;
  sender: 'human' | 'assistant';
  text: string;
  createdAt: string;
  parentUuid: string | null;
  inputMode: string | null;
  blocks: CodeBlock[];
}

export interface CodeSession {
  uuid: string;
  sessionId: string;
  projectDir: string;
  name: string;
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  createdAt: string;
  updatedAt: string;
  messages: CodeMessage[];
  redactions: number;
}

interface RawRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  aiTitle?: string;
  promptSource?: string;
  origin?: { kind?: string } | null;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
}

function blockText(blocks: CodeBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text as string)
    .join('\n\n');
}

function parseContent(content: unknown, counter: { n: number }): CodeBlock[] {
  const out: CodeBlock[] = [];
  if (typeof content === 'string') {
    const { text, count } = redact(content);
    counter.n += count;
    if (text.trim()) out.push({ position: 0, type: 'text', text, toolUseId: null, toolName: null, toolInputJson: null });
    return out;
  }
  if (!Array.isArray(content)) return out;

  for (const raw of content) {
    const b = raw as Record<string, unknown>;
    const pos = out.length;
    switch (b.type) {
      case 'text': {
        const { text, count } = redact(String(b.text ?? ''));
        counter.n += count;
        if (text.trim()) out.push({ position: pos, type: 'text', text, toolUseId: null, toolName: null, toolInputJson: null });
        break;
      }
      case 'thinking': {
        const { text, count } = redact(String(b.thinking ?? b.text ?? ''));
        counter.n += count;
        if (text.trim()) out.push({ position: pos, type: 'thinking', text, toolUseId: null, toolName: null, toolInputJson: null });
        break;
      }
      case 'tool_use':
      case 'server_tool_use': {
        if (typeof b.name !== 'string' || !MUTATING_TOOLS.has(b.name)) break;
        const { text: input, count } = redact(
          b.input === undefined ? '' : JSON.stringify(b.input).slice(0, MAX_TOOL_INPUT),
        );
        counter.n += count;
        out.push({
          position: pos,
          type: 'tool_use',
          text: null,
          toolUseId: typeof b.id === 'string' ? b.id : null,
          toolName: typeof b.name === 'string' ? b.name : null,
          toolInputJson: input || null,
        });
        break;
      }
      default:
        // tool_result, image, document and anything else is deliberately dropped:
        // it is machine output, it is where secrets live, and it is 98% of the bytes.
        break;
    }
  }
  return out;
}

export async function parseSessionFile(path: string, projectDir: string): Promise<CodeSession | null> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  const counter = { n: 0 };
  const messages: CodeMessage[] = [];
  const seenUuids = new Map<string, number>();
  let sessionId = '';
  let aiTitle = '';
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let version: string | null = null;
  let first = '';
  let last = '';

  for await (const line of rl) {
    if (!line.trim()) continue;
    let r: RawRecord;
    try {
      r = JSON.parse(line) as RawRecord;
    } catch {
      continue;
    }
    if (r.sessionId && !sessionId) sessionId = r.sessionId;
    // First cwd only. A session can cd into a subdirectory, and the project name is shared
    // by every session in the directory, so the last one would rename the whole project.
    if (r.cwd && !cwd) cwd = r.cwd;
    if (r.gitBranch) gitBranch = r.gitBranch;
    if (r.version) version = r.version;
    if (r.type === 'ai-title' && r.aiTitle) aiTitle = r.aiTitle;

    if (r.type !== 'user' && r.type !== 'assistant') continue;
    if (!r.uuid || !r.timestamp) continue;
    if (r.type === 'user' && !HUMAN_ORIGINS.has(r.origin?.kind ?? '')) continue;

    const blocks = parseContent(r.message?.content, counter);
    if (blocks.length === 0) continue;

    if (!first) first = r.timestamp;
    last = r.timestamp;
    const message: CodeMessage = {
      uuid: r.uuid,
      idx: messages.length,
      sender: r.type === 'user' ? 'human' : 'assistant',
      text: blockText(blocks),
      createdAt: r.timestamp,
      parentUuid: r.parentUuid ?? null,
      inputMode: r.type === 'user' ? r.promptSource ?? r.origin?.kind ?? null : null,
      blocks,
    };
    // A record can be rewritten in place later in the same file; the last write wins.
    const prior = seenUuids.get(r.uuid);
    if (prior === undefined) {
      seenUuids.set(r.uuid, messages.length);
      messages.push(message);
    } else {
      message.idx = prior;
      messages[prior] = message;
    }
  }

  if (!sessionId || messages.length === 0) return null;

  const merged = mergeToolOnlyTurns(messages);

  // Resuming a session copies earlier records into the new file, so a message uuid is
  // only unique within one session. Scope it, or two sessions collide on the messages PK.
  for (const m of merged) {
    m.uuid = `code:${sessionId}:${m.uuid}`;
    m.parentUuid = m.parentUuid ? `code:${sessionId}:${m.parentUuid}` : null;
  }

  const firstHuman = merged.find((m) => m.sender === 'human')?.text ?? '';
  const name = aiTitle || firstHuman.split('\n')[0].slice(0, 80) || '(untitled session)';

  return {
    uuid: `code:${sessionId}`,
    sessionId,
    projectDir,
    name,
    cwd,
    gitBranch,
    version,
    createdAt: first,
    updatedAt: last,
    messages: merged,
    redactions: counter.n,
  };
}

// An assistant turn that only ran tools carries no prose. Its tool calls fold into the
// neighbouring assistant message, backwards by preference and otherwise forwards, so the
// record of what ran survives without a blank message per call.
function mergeToolOnlyTurns(messages: CodeMessage[]): CodeMessage[] {
  const out: CodeMessage[] = [];
  let pending: CodeMessage | null = null;

  const renumber = (m: CodeMessage): CodeMessage => {
    m.blocks = m.blocks.map((b, i) => ({ ...b, position: i }));
    return m;
  };
  const push = (m: CodeMessage): void => {
    m.idx = out.length;
    out.push(renumber(m));
  };

  for (const m of messages) {
    const toolOnly = m.sender === 'assistant' && !m.text.trim() && m.blocks.every((b) => b.type === 'tool_use');
    if (toolOnly) {
      const prev = out[out.length - 1];
      if (prev?.sender === 'assistant') {
        prev.blocks.push(...m.blocks);
        renumber(prev);
      } else if (pending) {
        pending.blocks.push(...m.blocks);
      } else {
        pending = m;
      }
      continue;
    }
    if (pending) {
      if (m.sender === 'assistant') {
        m.blocks = [...pending.blocks, ...m.blocks];
      } else {
        push(pending);
      }
      pending = null;
    }
    push(m);
  }
  if (pending) push(pending);
  return out;
}

export interface SessionFile {
  path: string;
  projectDir: string;
  mtimeMs: number;
  size: number;
}

export async function discoverSessionFiles(root = SESSIONS_DIR): Promise<SessionFile[]> {
  const out: SessionFile[] = [];
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = (await readdir(join(root, dir))).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of entries) {
      const path = join(root, dir, file);
      try {
        const s = await stat(path);
        out.push({ path, projectDir: dir, mtimeMs: Math.floor(s.mtimeMs), size: s.size });
      } catch {
        continue;
      }
    }
  }
  return out;
}

export function projectNameFor(projectDir: string, cwd: string | null): string {
  if (cwd) return cwd.replace(homedir(), '~');
  return basename(projectDir.replace(/^-/, '/').replace(/-/g, '/'));
}

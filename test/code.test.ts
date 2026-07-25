import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSessionFile } from '../src/lib/code.js';

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function base(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: SESSION,
    cwd: '/Users/test/Github/onoma',
    gitBranch: 'main',
    version: '2.1.214',
    ...extra,
  };
}

function writeSession(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lib-code-'));
  const path = join(dir, `${SESSION}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

const humanTurn = base({
  type: 'user',
  uuid: 'u1',
  timestamp: '2026-07-20T09:00:00.000Z',
  origin: { kind: 'human' },
  promptSource: 'typed',
  message: { role: 'user', content: 'Fix the invoicing bug in Stagent' },
});

const assistantTurn = base({
  type: 'assistant',
  uuid: 'a1',
  parentUuid: 'u1',
  timestamp: '2026-07-20T09:00:05.000Z',
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'The bug is probably in the rate calculation.' },
      { type: 'text', text: 'Found it. The rate lookup ignored the project override.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: '/app/Rate.php', old_string: 'a', new_string: 'b' } },
    ],
  },
});

const toolResultTurn = base({
  type: 'user',
  uuid: 'u2',
  timestamp: '2026-07-20T09:00:06.000Z',
  toolUseResult: {},
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'DB_PASSWORD=supersecretvalue123' }] }],
  },
});

describe('parseSessionFile', () => {
  it('keeps human turns and assistant replies, drops everything else', async () => {
    const path = writeSession([
      base({ type: 'mode', mode: 'normal' }),
      humanTurn,
      base({ type: 'attachment', uuid: 'x1', attachment: { type: 'deferred_tools_delta' } }),
      assistantTurn,
      toolResultTurn,
      base({ type: 'ai-title', aiTitle: 'Fix Stagent invoicing rate lookup' }),
    ]);
    const s = await parseSessionFile(path, '-Users-test-Github-onoma');
    expect(s).not.toBeNull();
    expect(s!.messages).toHaveLength(2);
    expect(s!.messages[0].sender).toBe('human');
    expect(s!.messages[0].text).toBe('Fix the invoicing bug in Stagent');
    expect(s!.messages[1].sender).toBe('assistant');
  });

  it('never stores tool results', async () => {
    const path = writeSession([humanTurn, assistantTurn, toolResultTurn]);
    const s = await parseSessionFile(path, '-Users-test-Github-onoma');
    const dump = JSON.stringify(s);
    expect(dump).not.toContain('supersecretvalue123');
    expect(dump).not.toContain('tool_result');
  });

  it('skips non-human user records such as sdk and task notifications', async () => {
    const path = writeSession([
      base({ type: 'user', uuid: 'u9', timestamp: '2026-07-20T09:00:00.000Z', promptSource: 'sdk', message: { role: 'user', content: 'internal harness prompt' } }),
      base({ type: 'user', uuid: 'u10', timestamp: '2026-07-20T09:00:01.000Z', origin: { kind: 'task-notification' }, message: { role: 'user', content: 'task done' } }),
      humanTurn,
    ]);
    const s = await parseSessionFile(path, '-Users-test-Github-onoma');
    expect(s!.messages).toHaveLength(1);
    expect(s!.messages[0].text).toBe('Fix the invoicing bug in Stagent');
  });

  it('keeps thinking and tool_use as blocks but only text in the searchable body', async () => {
    const path = writeSession([humanTurn, assistantTurn]);
    const s = await parseSessionFile(path, '-Users-test-Github-onoma');
    const assistant = s!.messages[1];
    expect(assistant.text).toBe('Found it. The rate lookup ignored the project override.');
    expect(assistant.blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(assistant.blocks[2].toolName).toBe('Edit');
    expect(assistant.blocks[2].toolInputJson).toContain('Rate.php');
  });

  it('keeps mutating tool calls and drops read-only ones', async () => {
    const turn = base({
      type: 'assistant', uuid: 'a2', timestamp: '2026-07-20T09:00:05.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/app/Rate.php' } },
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'php artisan migrate' } },
        ],
      },
    });
    const s = await parseSessionFile(writeSession([humanTurn, turn]), 'd');
    expect(s!.messages[1].blocks).toHaveLength(1);
    expect(s!.messages[1].blocks[0].toolName).toBe('Bash');
  });

  it('folds tool-only assistant turns into the preceding assistant message', async () => {
    const toolOnly = base({
      type: 'assistant', uuid: 'a4', timestamp: '2026-07-20T09:00:09.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'git push' } }] },
    });
    const s = await parseSessionFile(writeSession([humanTurn, assistantTurn, toolOnly]), 'd');
    expect(s!.messages).toHaveLength(2);
    const assistant = s!.messages[1];
    expect(assistant.blocks.map((b) => b.toolName)).toEqual([null, null, 'Edit', 'Bash']);
    expect(assistant.blocks.map((b) => b.position)).toEqual([0, 1, 2, 3]);
  });

  it('folds a tool-only turn forward when no assistant message precedes it', async () => {
    const toolOnly = base({
      type: 'assistant', uuid: 'a5', timestamp: '2026-07-20T09:00:06.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'ls' } }] },
    });
    const s = await parseSessionFile(writeSession([humanTurn, toolOnly, assistantTurn]), 'd');
    expect(s!.messages).toHaveLength(2);
    expect(s!.messages[1].text).toBe('Found it. The rate lookup ignored the project override.');
    expect(s!.messages[1].blocks.map((b) => b.toolName)).toEqual(['Bash', null, null, 'Edit']);
    expect(s!.messages[1].blocks.map((b) => b.position)).toEqual([0, 1, 2, 3]);
  });

  it('keeps a tool-only turn that has no assistant message on either side', async () => {
    const toolOnly = base({
      type: 'assistant', uuid: 'a5', timestamp: '2026-07-20T09:00:06.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'ls' } }] },
    });
    const s = await parseSessionFile(writeSession([humanTurn, toolOnly]), 'd');
    expect(s!.messages).toHaveLength(2);
    expect(s!.messages.map((m) => m.idx)).toEqual([0, 1]);
  });

  it('takes the first cwd so a mid-session cd cannot rename the project', async () => {
    const moved = base({
      type: 'assistant', uuid: 'a6', timestamp: '2026-07-20T09:00:06.000Z',
      cwd: '/Users/test/Github/onoma/web',
      message: { role: 'assistant', content: [{ type: 'text', text: 'moved' }] },
    });
    const s = await parseSessionFile(writeSession([humanTurn, moved]), 'd');
    expect(s!.cwd).toBe('/Users/test/Github/onoma');
  });

  it('drops assistant turns that carry only read-only tool calls', async () => {
    const turn = base({
      type: 'assistant', uuid: 'a3', timestamp: '2026-07-20T09:00:05.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'x' } }] },
    });
    const s = await parseSessionFile(writeSession([humanTurn, turn]), 'd');
    expect(s!.messages).toHaveLength(1);
  });

  it('redacts secrets in human turns and counts them', async () => {
    // Assembled at runtime so no credential-shaped literal sits in the source. See redact.test.ts.
    const key = ['sk-', 'ant-', 'api03-', 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH'].join('');
    const path = writeSession([
      base({
        type: 'user', uuid: 'u3', timestamp: '2026-07-20T09:00:00.000Z', origin: { kind: 'human' },
        message: { role: 'user', content: `deploy with ${key} please` },
      }),
    ]);
    const s = await parseSessionFile(path, '-Users-test-Github-onoma');
    expect(s!.messages[0].text).not.toContain(key);
    expect(s!.redactions).toBe(1);
  });

  it('prefers the ai-title, falls back to the first human line', async () => {
    const titled = await parseSessionFile(
      writeSession([humanTurn, base({ type: 'ai-title', aiTitle: 'Stagent invoicing' })]),
      'd',
    );
    expect(titled!.name).toBe('Stagent invoicing');
    const untitled = await parseSessionFile(writeSession([humanTurn]), 'd');
    expect(untitled!.name).toBe('Fix the invoicing bug in Stagent');
  });

  it('scopes message uuids to the session so resumed sessions cannot collide', async () => {
    const path = writeSession([humanTurn, assistantTurn]);
    const s = await parseSessionFile(path, '-Users-test-Github-onoma');
    expect(s!.messages[0].uuid).toBe(`code:${SESSION}:u1`);
    expect(s!.messages[1].parentUuid).toBe(`code:${SESSION}:u1`);
  });

  it('deduplicates records rewritten in place, keeping the last version', async () => {
    const first = base({
      type: 'assistant', uuid: 'a1', timestamp: '2026-07-20T09:00:05.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial answer' }] },
    });
    const rewritten = base({
      type: 'assistant', uuid: 'a1', timestamp: '2026-07-20T09:00:07.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'complete answer' }] },
    });
    const s = await parseSessionFile(writeSession([humanTurn, first, rewritten]), 'd');
    expect(s!.messages).toHaveLength(2);
    expect(s!.messages[1].text).toBe('complete answer');
    expect(s!.messages.map((m) => m.idx)).toEqual([0, 1]);
  });

  it('captures session metadata and time range', async () => {
    const path = writeSession([humanTurn, assistantTurn]);
    const s = await parseSessionFile(path, '-Users-test-Github-onoma');
    expect(s!.uuid).toBe(`code:${SESSION}`);
    expect(s!.cwd).toBe('/Users/test/Github/onoma');
    expect(s!.gitBranch).toBe('main');
    expect(s!.createdAt).toBe('2026-07-20T09:00:00.000Z');
    expect(s!.updatedAt).toBe('2026-07-20T09:00:05.000Z');
  });

  it('returns null for a session with no human or assistant content', async () => {
    const path = writeSession([base({ type: 'mode', mode: 'normal' }), toolResultTurn]);
    expect(await parseSessionFile(path, 'd')).toBeNull();
  });

  it('survives malformed lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lib-code-'));
    const path = join(dir, `${SESSION}.jsonl`);
    writeFileSync(path, `{"broken"\n\n${JSON.stringify(humanTurn)}\n`);
    const s = await parseSessionFile(path, 'd');
    expect(s!.messages).toHaveLength(1);
  });
});

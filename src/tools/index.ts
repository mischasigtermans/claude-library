import { readClaudeCookies, type ClaudeCookies } from '../lib/auth.js';
import {
  getConversation,
  getOrgMemory,
  getProject,
  iterateConversations,
  listOrgs,
  listProjectDocs,
  listProjectFiles,
  listProjects,
  listShares as apiListShares,
  SessionExpiredError,
  type Org,
} from '../lib/api.js';
import {
  findProjectByName,
  getArtifact,
  getCached,
  getConversationFreshness,
  getDoc,
  getLatestMemory,
  getMemoryById,
  getMessages,
  getMeta,
  getProjectCached,
  insertMemorySnapshot,
  lastSyncedAt,
  listCached,
  listMemorySnapshots,
  listProjectsCached,
  listShares as cacheListShares,
  queryCitations,
  queryToolCalls,
  replaceProjectDocs,
  search as searchCache,
  searchArtifacts,
  searchDocs,
  searchMemory,
  setMeta,
  totalConversations,
  totalDocs,
  upsertConversation,
  upsertMessages,
  upsertProject,
  upsertProjectFiles,
  upsertShare,
} from '../lib/cache.js';

export interface Tool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  handler: (args: Record<string, unknown>) => Promise<string>;
}

const STALE_HOURS = 24;
const STALE_MS = STALE_HOURS * 60 * 60 * 1000;

function fmtDate(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

function trim(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

interface SyncStats {
  org: string;
  newConvos: number;
  updatedConvos: number;
  unchangedConvos: number;
  failedConvos: number;
  newMessages: number;
  projects: number;
  docs: number;
  skipped?: string;
  failureSamples: string[];
}

function recordFailure(stats: SyncStats, where: string, err: unknown): void {
  if (stats.failureSamples.length >= 5) return;
  const msg = err instanceof Error ? err.message : String(err);
  stats.failureSamples.push(`${where}: ${msg.slice(0, 300)}`);
}

async function syncOrg(
  cookies: ClaudeCookies,
  org: Org,
  opts: { full: boolean; pageSize?: number },
): Promise<SyncStats> {
  const stats: SyncStats = {
    org: org.name,
    newConvos: 0,
    updatedConvos: 0,
    unchangedConvos: 0,
    failedConvos: 0,
    newMessages: 0,
    projects: 0,
    docs: 0,
    failureSamples: [],
  };

  try {
    const projects = await listProjects(cookies, org.uuid);
    for (const p of projects) upsertProject(org.uuid, p);
    stats.projects = projects.length;
    for (const p of projects) {
      try {
        const extended = await getProject(cookies, org.uuid, p.uuid);
        upsertProject(org.uuid, extended);
      } catch (err) {
        if (err instanceof SessionExpiredError) throw err;
        recordFailure(stats, `getProject ${p.name}`, err);
      }
      try {
        const pfiles = await listProjectFiles(cookies, org.uuid, p.uuid);
        upsertProjectFiles(p.uuid, pfiles);
      } catch (err) {
        if (err instanceof SessionExpiredError) throw err;
        recordFailure(stats, `listProjectFiles ${p.name}`, err);
      }
      try {
        const docs = await listProjectDocs(cookies, org.uuid, p.uuid);
        if (docs.length > 0) {
          replaceProjectDocs(p.uuid, docs);
          stats.docs += docs.length;
        }
      } catch (err) {
        if (err instanceof SessionExpiredError) throw err;
        recordFailure(stats, `listProjectDocs ${p.name}`, err);
      }
    }
  } catch (err) {
    if (err instanceof SessionExpiredError) throw err;
    recordFailure(stats, 'listProjects', err);
  }

  try {
    const mem = await getOrgMemory(cookies, org.uuid);
    insertMemorySnapshot(
      org.uuid,
      mem.memory,
      mem.controls !== null && mem.controls !== undefined ? JSON.stringify(mem.controls) : null,
      mem.updated_at,
    );
  } catch (err) {
    if (err instanceof SessionExpiredError) throw err;
  }

  try {
    const shares = await apiListShares(cookies, org.uuid);
    for (const s of shares) upsertShare(org.uuid, s);
  } catch (err) {
    if (err instanceof SessionExpiredError) throw err;
  }

  try {
    for await (const conv of iterateConversations(cookies, org.uuid, {
      pageSize: opts.pageSize ?? 100,
    })) {
      const cached = getConversationFreshness(conv.uuid);
      const isNew = !cached;
      const changed = !isNew && cached.updated_at < conv.updated_at;
      const messagesStale = !cached?.messages_synced_for || cached.messages_synced_for < conv.updated_at;

      upsertConversation(org.uuid, conv);

      if (isNew) stats.newConvos++;
      else if (changed) stats.updatedConvos++;
      else stats.unchangedConvos++;

      if (opts.full || isNew || messagesStale) {
        try {
          const full = await getConversation(cookies, org.uuid, conv.uuid);
          upsertMessages(full);
          stats.newMessages += full.chat_messages.length;
        } catch (err) {
          if (err instanceof SessionExpiredError) throw err;
          stats.failedConvos++;
          recordFailure(stats, `getConversation ${conv.name?.slice(0, 40) ?? conv.uuid}`, err);
        }
      }
    }
  } catch (err) {
    if (err instanceof SessionExpiredError) throw err;
    stats.skipped = err instanceof Error ? err.message.slice(0, 500) : String(err);
  }

  return stats;
}

async function performSync(opts: { full?: boolean; org?: string } = {}): Promise<SyncStats[]> {
  const cookies = readClaudeCookies();
  const orgs = await listOrgs(cookies);
  const filter = opts.org?.toLowerCase();
  const targets = filter
    ? orgs.filter((o) => o.uuid === opts.org || o.name.toLowerCase().includes(filter))
    : orgs;
  const results: SyncStats[] = [];
  for (const org of targets) {
    results.push(await syncOrg(cookies, org, { full: Boolean(opts.full) }));
  }
  setMeta('last_sync_completed_at', new Date().toISOString());
  return results;
}

function formatSyncReport(results: SyncStats[]): string {
  if (results.length === 0) return 'No orgs to sync.';
  const lines: string[] = [];
  let totals = { n: 0, u: 0, k: 0, f: 0, m: 0, p: 0, d: 0 };
  for (const r of results) {
    if (r.skipped) {
      lines.push(`  ${r.org}: skipped (${r.skipped})`);
      continue;
    }
    lines.push(
      `  ${r.org}: ${r.newConvos} new, ${r.updatedConvos} updated, ${r.unchangedConvos} unchanged, ${r.projects} projects, ${r.docs} project docs` +
        (r.failedConvos ? `, ${r.failedConvos} failed` : ''),
    );
    for (const sample of r.failureSamples) {
      lines.push(`    ! ${sample}`);
    }
    totals.n += r.newConvos;
    totals.u += r.updatedConvos;
    totals.k += r.unchangedConvos;
    totals.f += r.failedConvos;
    totals.m += r.newMessages;
    totals.p += r.projects;
    totals.d += r.docs;
  }
  const summary =
    `Synced ${totals.n + totals.u} conversations (${totals.n} new, ${totals.u} updated, ${totals.k} already current), ` +
    `${totals.m} messages indexed, ${totals.p} projects, ${totals.d} project docs.`;
  return [summary, ...lines].join('\n');
}

async function autoSyncIfStale(): Promise<string | null> {
  const last = getMeta('last_sync_completed_at');
  if (last && Date.now() - new Date(last).getTime() < STALE_MS) return null;
  try {
    const results = await performSync({ full: false });
    setMeta('last_auto_sync_error', '');
    const totals = results.reduce(
      (a, r) => a + (r.skipped ? 0 : r.newConvos + r.updatedConvos),
      0,
    );
    if (totals === 0) return null;
    return `(auto-synced ${totals} new/updated conversations)`;
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    setMeta('last_auto_sync_error', JSON.stringify({ at: new Date().toISOString(), message: msg.slice(0, 300) }));
    return `(auto-sync failed: ${msg})`;
  }
}

const sync: Tool = {
  name: 'library_sync',
  description:
    'Pull new and updated conversations from Claude Desktop. Incremental by default. Only fetches messages for conversations that changed since last sync. Captures regen branches and message tree (tree=True). Pass full=true to re-fetch everything.',
  inputSchema: {
    type: 'object',
    properties: {
      org: { type: 'string', description: 'Optional org name or UUID. Defaults to all orgs.' },
      full: {
        type: 'boolean',
        description: 'Force full re-sync of all conversations and messages. Default false.',
      },
    },
  },
  handler: async (args) => {
    const results = await performSync({
      full: Boolean(args.full),
      org: typeof args.org === 'string' ? args.org : undefined,
    });
    return formatSyncReport(results);
  },
};

const list: Tool = {
  name: 'library_list',
  description:
    'List recent Claude Desktop conversations from the local cache, newest first. Auto-syncs if cache is older than 24 hours. Filter by project name or UUID.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max rows (default 25).' },
      project: { type: 'string', description: 'Project name or UUID to filter by.' },
      noSync: { type: 'boolean', description: 'Skip the freshness auto-sync. Default false.' },
    },
  },
  handler: async (args) => {
    const note = args.noSync ? null : await autoSyncIfStale();
    const limit = Number(args.limit ?? 25);
    let projectUuid: string | undefined;
    if (typeof args.project === 'string') {
      const p = findProjectByName(args.project);
      if (!p) return `No project matches "${args.project}". Try library_projects to list them.`;
      projectUuid = p.uuid;
    }
    const rows = listCached({ limit, projectUuid });
    if (rows.length === 0) {
      return 'No cached conversations. Run library_sync first.';
    }
    const lastSync = lastSyncedAt();
    const total = totalConversations();
    const header = `${rows.length} of ${total} cached conversations (last sync: ${lastSync ? fmtDate(lastSync) : 'never'}):`;
    const body = rows
      .map((r) => {
        const tag = r.messages_synced ? `${r.message_count}msg` : 'list-only';
        return `  ${fmtDate(r.updated_at)}  ${tag.padEnd(10)}  ${trim(r.name || '(untitled)', 60).padEnd(62)}  ${r.uuid}`;
      })
      .join('\n');
    return [note, header, body].filter(Boolean).join('\n');
  },
};

const search: Tool = {
  name: 'library_search',
  description:
    'Search the local Claude Desktop library. The `kind` arg dispatches to one of several backends: messages, docs, memory, and artifacts use FTS5 (phrase quotes, AND/OR/NOT supported); citations use LIKE on title/url/site_name; tool_calls is exact-match on tool name; shares is substring match on snapshot_name. With `kind=all` (default), messages + docs + memory + artifacts are searched in parallel and merged. With `kind=memory` and no query, returns the snapshot history. Auto-syncs if cache is older than 24 hours.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'FTS5 query string.' },
      limit: { type: 'number', description: 'Max hits (default 20 for messages, 25 for others).' },
      docLimit: { type: 'number', description: 'Max document hits when kind=all (default 10).' },
      kind: {
        type: 'string',
        enum: ['all', 'messages', 'docs', 'memory', 'artifacts', 'tool_calls', 'citations', 'shares'],
        description: 'Filter results to one source. Default "all".',
      },
      noSync: { type: 'boolean', description: 'Skip the freshness auto-sync. Default false.' },
    },
    required: ['query'],
  },
  handler: async (args) => {
    const q = String(args.query ?? '');
    if (!q.trim()) throw new Error('query is required');
    const note = args.noSync ? null : await autoSyncIfStale();
    const kind = typeof args.kind === 'string' ? args.kind : 'all';
    const limit = Number(args.limit ?? 20);

    if (kind === 'messages') {
      const hits = searchCache(q, limit);
      if (hits.length === 0) return [note, `No message matches for "${q}".`].filter(Boolean).join('\n');
      const body = hits
        .map(
          (h) =>
            `[${h.sender}] ${trim(h.conversation_name, 50)}${h.conv_starred ? ' ★' : ''}  (${h.conversation_uuid})\n  ${h.snippet}`,
        )
        .join('\n\n');
      return [note, `Messages (${hits.length}):\n${body}`].filter(Boolean).join('\n\n');
    }

    if (kind === 'docs') {
      const hits = searchDocs(q, limit);
      if (hits.length === 0) return [note, `No doc matches for "${q}".`].filter(Boolean).join('\n');
      const body = hits
        .map(
          (h) =>
            `[doc] ${trim(h.file_name, 40)}  in ${h.project_name ?? '(unknown project)'}  (${h.doc_uuid})\n  ${h.snippet}`,
        )
        .join('\n\n');
      return [note, `Project docs (${hits.length}):\n${body}`].filter(Boolean).join('\n\n');
    }

    if (kind === 'memory') {
      const hits = searchMemory(q, limit);
      if (hits.length === 0) {
        // Fall back to listing snapshots as browse mode
        const rows = listMemorySnapshots();
        if (rows.length === 0) return 'No memory snapshots cached. Run library_sync first.';
        const body = rows
          .map((r) => `  #${String(r.id).padStart(4)}  ${fmtDate(r.remote_updated_at)}  ${r.char_count} chars`)
          .join('\n');
        return `${rows.length} memory snapshot(s):\n${body}`;
      }
      const body = hits
        .map((h) => `[memory #${h.snapshot_id}] ${fmtDate(h.remote_updated_at)}\n  ${h.snippet}`)
        .join('\n\n');
      return [note, `Memory (${hits.length}):\n${body}`].filter(Boolean).join('\n\n');
    }

    if (kind === 'artifacts') {
      const hits = searchArtifacts({ query: q, limit });
      if (hits.length === 0) return [note, `No artifact matches for "${q}".`].filter(Boolean).join('\n');
      const body = hits
        .map(
          (h) =>
            `[${h.artifact_type ?? 'artifact'}] ${h.title ? trim(h.title, 40) + '  ' : ''}${trim(h.conversation_name, 50)}${h.conv_starred ? ' ★' : ''}  (${h.artifact_uuid})\n  ${h.snippet}`,
        )
        .join('\n\n');
      return [note, `Artifacts (${hits.length}):\n${body}`].filter(Boolean).join('\n\n');
    }

    if (kind === 'tool_calls') {
      const hits = queryToolCalls({ tool: q, limit });
      if (hits.length === 0) return [note, `No tool call matches for "${q}".`].filter(Boolean).join('\n');
      const body = hits
        .map((h) => {
          const ts = fmtDate(h.created_at);
          const integ = h.integration_name ? ` [${h.integration_name}]` : '';
          return `  ${ts}  ${h.tool_name}${integ}  ${trim(h.conversation_name, 50)}\n        ${h.input_snippet}`;
        })
        .join('\n');
      return [note, `Tool calls (${hits.length}):\n${body}`].filter(Boolean).join('\n\n');
    }

    if (kind === 'citations') {
      const hits = queryCitations({ query: q, limit });
      if (hits.length === 0) return [note, `No citation matches for "${q}".`].filter(Boolean).join('\n');
      const body = hits
        .map((h) => {
          const domain = h.site_domain ?? '(unknown domain)';
          const title = h.title ? trim(h.title, 60) : '(no title)';
          const url = h.url ? trim(h.url, 80) : '';
          return `  ${domain.padEnd(30)}  ${title}\n        ${url}\n        ${trim(h.conversation_name, 60)}  (${h.conversation_uuid})`;
        })
        .join('\n');
      return [note, `Citations (${hits.length}):\n${body}`].filter(Boolean).join('\n\n');
    }

    if (kind === 'shares') {
      const rows = cacheListShares({});
      const lower = q.toLowerCase();
      const matches = rows.filter(
        (s) =>
          (s.snapshot_name ?? '').toLowerCase().includes(lower) ||
          (s.conversation_name ?? '').toLowerCase().includes(lower) ||
          (s.conversation_uuid ?? '').toLowerCase().includes(lower),
      );
      if (matches.length === 0) return [note, `No share matches for "${q}".`].filter(Boolean).join('\n');
      const body = matches
        .map((s) => {
          const name = s.snapshot_name ? trim(s.snapshot_name, 50) : '(unnamed)';
          const convo = s.conversation_name ? trim(s.conversation_name, 50) : (s.conversation_uuid ?? '-');
          const idx = s.last_message_index !== null ? ` (up to msg ${s.last_message_index})` : '';
          const date = s.created_at ? fmtDate(s.created_at) : '-';
          return `  ${date}  ${name.padEnd(52)}  ${convo}${idx}\n           ${s.uuid}`;
        })
        .join('\n');
      return [note, `Shares (${matches.length}):\n${body}`].filter(Boolean).join('\n\n');
    }

    // kind === 'all'
    const msgHits = searchCache(q, limit);
    const docHits = searchDocs(q, Number(args.docLimit ?? 10));
    const memHits = searchMemory(q, 3);
    const artHits = searchArtifacts({ query: q, limit: 10 });
    if (msgHits.length === 0 && docHits.length === 0 && memHits.length === 0 && artHits.length === 0) {
      return [note, `No matches for "${q}".`].filter(Boolean).join('\n');
    }
    const sections: string[] = [];
    if (msgHits.length > 0) {
      sections.push(
        `Messages (${msgHits.length}):\n` +
          msgHits
            .map(
              (h) =>
                `[${h.sender}] ${trim(h.conversation_name, 50)}${h.conv_starred ? ' ★' : ''}  (${h.conversation_uuid})\n  ${h.snippet}`,
            )
            .join('\n\n'),
      );
    }
    if (docHits.length > 0) {
      sections.push(
        `Project docs (${docHits.length}):\n` +
          docHits
            .map(
              (h) =>
                `[doc] ${trim(h.file_name, 40)}  in ${h.project_name ?? '(unknown project)'}  (${h.doc_uuid})\n  ${h.snippet}`,
            )
            .join('\n\n'),
      );
    }
    if (memHits.length > 0) {
      sections.push(
        `Memory (${memHits.length}):\n` +
          memHits
            .map((h) => `[memory #${h.snapshot_id}] ${fmtDate(h.remote_updated_at)}\n  ${h.snippet}`)
            .join('\n\n'),
      );
    }
    if (artHits.length > 0) {
      sections.push(
        `Artifacts (${artHits.length}):\n` +
          artHits
            .map(
              (h) =>
                `[${h.artifact_type ?? 'artifact'}] ${h.title ? trim(h.title, 40) + '  ' : ''}${trim(h.conversation_name, 50)}${h.conv_starred ? ' ★' : ''}  (${h.artifact_uuid})\n  ${h.snippet}`,
            )
            .join('\n\n'),
      );
    }
    return [note, sections.join('\n\n')].filter(Boolean).join('\n\n');
  },
};

const outline: Tool = {
  name: 'library_outline',
  description:
    'Show a conversation as a turn-by-turn outline (sender + first ~120 chars of each message). Use this before pulling the full transcript to avoid blowing context.',
  inputSchema: {
    type: 'object',
    properties: { uuid: { type: 'string', description: 'Conversation UUID.' } },
    required: ['uuid'],
  },
  handler: async (args) => {
    const uuid = String(args.uuid);
    const meta = getCached(uuid);
    if (!meta) return `Conversation ${uuid} not in cache. Run library_sync.`;
    if (!meta.messages_synced) {
      return `Conversation "${meta.name}" has no messages cached. Run library_sync with full=true.`;
    }
    const msgs = getMessages(uuid);
    const head = `${meta.name}  (${msgs.length} messages, ${fmtDate(meta.created_at)} → ${fmtDate(meta.updated_at)})`;
    const body = msgs
      .map((m) => `${String(m.idx).padStart(3)} ${m.sender.padEnd(9)} ${trim(m.text.replace(/\s+/g, ' '), 120)}`)
      .join('\n');
    return `${head}\n${body}`;
  },
};

const open: Tool = {
  name: 'library_open',
  description:
    'Open one item by UUID. Detects whether the UUID belongs to a conversation, project doc, artifact, share, or memory snapshot and returns the appropriate content. For conversations, optional from/to bounds restrict which messages are shown.',
  inputSchema: {
    type: 'object',
    properties: {
      uuid: { type: 'string', description: 'UUID (conversation, doc, artifact, share, or memory snapshot id).' },
      from: { type: 'number', description: 'Start message index (inclusive). Conversations only. Default 0.' },
      to: { type: 'number', description: 'End message index (exclusive). Conversations only. Default end.' },
    },
    required: ['uuid'],
  },
  handler: async (args) => {
    const uuid = String(args.uuid);

    // Probe conversations
    const meta = getCached(uuid);
    if (meta) {
      if (!meta.messages_synced) {
        return `Conversation "${meta.name}" has no messages cached. Run library_sync with full=true.`;
      }
      let msgs = getMessages(uuid);
      const from = Number(args.from ?? 0);
      const to = args.to !== undefined ? Number(args.to) : msgs.length;
      msgs = msgs.slice(from, to);
      const head = `# ${meta.name}\n_${fmtDate(meta.created_at)} → ${fmtDate(meta.updated_at)}, ${meta.message_count} messages, showing ${from}–${from + msgs.length - 1}_\n`;
      const body = msgs.map((m) => `\n## ${m.sender} [${m.idx}]\n\n${m.text}`).join('\n');
      return head + body;
    }

    // Probe project_docs
    const d = getDoc(uuid);
    if (d) {
      const head = `# ${d.file_name}\n_project: ${d.project_name ?? '(unknown)'}, created ${fmtDate(d.created_at)}, ~${d.estimated_tokens ?? '?'} tokens_\n`;
      return head + '\n' + d.content;
    }

    // Probe artifacts
    const a = getArtifact(uuid);
    if (a) {
      const head = [
        `# ${a.title ?? '(untitled)'}`,
        `type: ${a.artifact_type ?? '(unknown)'}  lines: ${a.line_count}  chars: ${a.char_count}`,
        `source: ${a.source}${a.identifier ? `  id: ${a.identifier}` : ''}`,
        `conversation: ${a.conversation_name}  (${a.conversation_uuid})`,
        `message: ${a.message_uuid}`,
        a.created_at ? `created: ${fmtDate(a.created_at)}` : '',
      ].filter(Boolean).join('\n');
      const fence = a.artifact_type ? `\`\`\`${a.artifact_type}` : '```';
      return `${head}\n\n${fence}\n${a.content}\n\`\`\``;
    }

    // Probe shares
    const shareRows = cacheListShares({});
    const share = shareRows.find((s) => s.uuid === uuid);
    if (share) {
      const name = share.snapshot_name ?? '(unnamed)';
      const convo = share.conversation_uuid ?? '-';
      const idx = share.last_message_index !== null ? ` (up to msg ${share.last_message_index})` : '';
      const date = share.created_at ? fmtDate(share.created_at) : '-';
      return `Share: ${name}\ndate: ${date}\nconversation_uuid: ${convo}${idx}`;
    }

    // Probe memory_snapshots (numeric id)
    const numId = Number(uuid);
    if (!isNaN(numId) && String(numId) === uuid.trim()) {
      const snap = getMemoryById(numId);
      if (snap) {
        const head = `# Organization memory (snapshot #${snap.id}, ${fmtDate(snap.remote_updated_at)})\n`;
        return head + '\n' + snap.memory;
      }
    }

    return `Unknown uuid ${uuid}. Try library_list or library_search.`;
  },
};

const projects: Tool = {
  name: 'library_projects',
  description:
    'List Claude Desktop projects with conversation counts. Pass name= to filter to one project. Add detail=true to return the full record including system prompt.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Project name or UUID to filter by.' },
      detail: { type: 'boolean', description: 'Return full project record including prompt_template. Requires name.' },
      noSync: { type: 'boolean', description: 'Skip the freshness auto-sync. Default false.' },
    },
  },
  handler: async (args) => {
    const note = args.noSync ? null : await autoSyncIfStale();

    if (typeof args.name === 'string' && args.detail) {
      const nameOrUuid = args.name;
      const p = getProjectCached(nameOrUuid);
      if (!p) return `No project matches "${nameOrUuid}". Try library_projects to list them.`;
      const lines: string[] = [
        `# ${p.name}`,
        `uuid: ${p.uuid}`,
        `conversations: ${p.conversation_count}`,
      ];
      if (p.description) lines.push(`description: ${p.description}`);
      if (p.archived_at) lines.push(`archived: ${fmtDate(p.archived_at)}`);
      lines.push(`created: ${fmtDate(p.created_at)}`);
      const ext = p as Record<string, unknown>;
      if (ext.docs_count !== undefined) lines.push(`docs: ${ext.docs_count}  files: ${ext.files_count ?? 0}`);
      lines.push('');
      if (ext.prompt_template) {
        lines.push('## System prompt');
        lines.push(String(ext.prompt_template));
      } else {
        lines.push('(no system prompt)');
      }
      return [note, lines.join('\n')].filter(Boolean).join('\n\n');
    }

    if (typeof args.name === 'string') {
      const p = findProjectByName(args.name);
      if (!p) return `No project matches "${args.name}". Try library_projects to list them.`;
      const star = p.is_starred ? '★' : ' ';
      const archived = p.archived_at ? ' (archived)' : '';
      const desc = p.description ? `  ${trim(p.description, 60)}` : '';
      const line = `${star} ${String(p.conversation_count).padStart(4)} convos  ${trim(p.name, 40).padEnd(42)}${desc}${archived}\n     ${p.uuid}`;
      return [note, line].filter(Boolean).join('\n\n');
    }

    const rows = listProjectsCached();
    if (rows.length === 0) return [note, 'No projects cached. Run library_sync.'].filter(Boolean).join('\n');
    const body = rows
      .map((p) => {
        const star = p.is_starred ? '★' : ' ';
        const archived = p.archived_at ? ' (archived)' : '';
        const desc = p.description ? `  ${trim(p.description, 60)}` : '';
        const hasPrompt = (p as Record<string, unknown>).prompt_template ? ' [prompt]' : '';
        return `${star} ${String(p.conversation_count).padStart(4)} convos  ${trim(p.name, 40).padEnd(42)}${desc}${hasPrompt}${archived}\n     ${p.uuid}`;
      })
      .join('\n');
    return [note, body].filter(Boolean).join('\n\n');
  },
};

const status: Tool = {
  name: 'library_status',
  description:
    'Report cache state: total conversations, last sync time, and a quick auth check against Claude Desktop cookies.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    let auth = 'ok';
    try {
      readClaudeCookies();
    } catch (err) {
      auth = `failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    const total = totalConversations();
    const last = lastSyncedAt();
    const lastFull = getMeta('last_sync_completed_at');
    const projectCount = listProjectsCached().length;
    const docCount = totalDocs();
    const lines = [
      `auth: ${auth}`,
      `cached conversations: ${total}`,
      `cached projects: ${projectCount}`,
      `cached project docs: ${docCount}`,
      `last conversation sync: ${last ? fmtDate(last) : 'never'}`,
      `last full sync run: ${lastFull ? fmtDate(lastFull) : 'never'}`,
    ];
    const autoSyncError = getMeta('last_auto_sync_error');
    if (autoSyncError) {
      try {
        const e = JSON.parse(autoSyncError) as { at: string; message: string };
        lines.push(`auto-sync error (at ${fmtDate(e.at)}): ${e.message}`);
      } catch {
        // malformed meta value, ignore
      }
    }
    return lines.join('\n');
  },
};

export const tools: Tool[] = [sync, list, search, outline, open, projects, status];

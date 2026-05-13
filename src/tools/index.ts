import { readClaudeCookies, type ClaudeCookies } from '../lib/auth.js';
import {
  getConversation,
  iterateConversations,
  listOrgs,
  listProjectDocs,
  listProjects,
  SessionExpiredError,
  type Org,
} from '../lib/api.js';
import {
  findProjectByName,
  getCached,
  getConversationFreshness,
  getDoc,
  getMessages,
  getMeta,
  lastSyncedAt,
  listCached,
  listProjectsCached,
  queryCitations,
  queryToolCalls,
  replaceProjectDocs,
  search as searchCache,
  searchDocs,
  setMeta,
  totalConversations,
  totalDocs,
  upsertConversation,
  upsertMessages,
  upsertProject,
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
  };

  try {
    const projects = await listProjects(cookies, org.uuid);
    for (const p of projects) upsertProject(org.uuid, p);
    stats.projects = projects.length;
    for (const p of projects) {
      try {
        const docs = await listProjectDocs(cookies, org.uuid, p.uuid);
        if (docs.length > 0) {
          replaceProjectDocs(p.uuid, docs);
          stats.docs += docs.length;
        }
      } catch (err) {
        if (err instanceof SessionExpiredError) throw err;
        // Per-project doc fetch failures are non-fatal.
      }
    }
  } catch (err) {
    if (err instanceof SessionExpiredError) throw err;
    // Older orgs may have no projects endpoint.
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
        }
      }
    }
  } catch (err) {
    if (err instanceof SessionExpiredError) throw err;
    stats.skipped = err instanceof Error ? err.message.split('\n')[0] : String(err);
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
    const totals = results.reduce(
      (a, r) => a + (r.skipped ? 0 : r.newConvos + r.updatedConvos),
      0,
    );
    if (totals === 0) return null;
    return `(auto-synced ${totals} new/updated conversations)`;
  } catch (err) {
    return `(auto-sync failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)})`;
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
    'Full-text search across cached message bodies and project knowledge-base documents. Auto-syncs if cache is older than 24 hours. Returns ranked snippets. Supports FTS5 syntax (phrase quotes, AND/OR/NOT).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'FTS5 query string.' },
      limit: { type: 'number', description: 'Max message hits (default 20).' },
      docLimit: { type: 'number', description: 'Max document hits (default 10).' },
      noSync: { type: 'boolean', description: 'Skip the freshness auto-sync. Default false.' },
    },
    required: ['query'],
  },
  handler: async (args) => {
    const q = String(args.query ?? '');
    if (!q.trim()) throw new Error('query is required');
    const note = args.noSync ? null : await autoSyncIfStale();
    const msgHits = searchCache(q, Number(args.limit ?? 20));
    const docHits = searchDocs(q, Number(args.docLimit ?? 10));
    if (msgHits.length === 0 && docHits.length === 0) {
      return [note, `No matches for "${q}".`].filter(Boolean).join('\n');
    }
    const sections: string[] = [];
    if (msgHits.length > 0) {
      sections.push(
        `Messages (${msgHits.length}):\n` +
          msgHits
            .map(
              (h) =>
                `[${h.sender}] ${trim(h.conversation_name, 50)}  (${h.conversation_uuid})\n  ${h.snippet}`,
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

const get: Tool = {
  name: 'library_get',
  description:
    'Return the full transcript of one conversation. Optionally restrict to a message index range to avoid context bloat.',
  inputSchema: {
    type: 'object',
    properties: {
      uuid: { type: 'string', description: 'Conversation UUID.' },
      from: { type: 'number', description: 'Start index (inclusive). Default 0.' },
      to: { type: 'number', description: 'End index (exclusive). Default end.' },
    },
    required: ['uuid'],
  },
  handler: async (args) => {
    const uuid = String(args.uuid);
    const meta = getCached(uuid);
    if (!meta) return `Conversation ${uuid} not in cache. Run library_sync.`;
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
  },
};

const doc: Tool = {
  name: 'library_doc',
  description:
    'Return the full text of one project knowledge-base document. Use this after library_search surfaces a [doc] hit you want to read in full.',
  inputSchema: {
    type: 'object',
    properties: {
      uuid: { type: 'string', description: 'Doc UUID (from library_search results).' },
    },
    required: ['uuid'],
  },
  handler: async (args) => {
    const uuid = String(args.uuid);
    const d = getDoc(uuid);
    if (!d) return `Doc ${uuid} not in cache. Run library_sync.`;
    const head = `# ${d.file_name}\n_project: ${d.project_name ?? '(unknown)'}, created ${fmtDate(d.created_at)}, ~${d.estimated_tokens ?? '?'} tokens_\n`;
    return head + '\n' + d.content;
  },
};

const projects: Tool = {
  name: 'library_projects',
  description:
    'List Claude Desktop projects with the count of cached conversations in each. Use the UUID or name with library_list to filter conversations by project.',
  inputSchema: {
    type: 'object',
    properties: {
      noSync: { type: 'boolean', description: 'Skip the freshness auto-sync. Default false.' },
    },
  },
  handler: async (args) => {
    const note = args.noSync ? null : await autoSyncIfStale();
    const rows = listProjectsCached();
    if (rows.length === 0) return [note, 'No projects cached. Run library_sync.'].filter(Boolean).join('\n');
    const body = rows
      .map((p) => {
        const star = p.is_starred ? '★' : ' ';
        const archived = p.archived_at ? ' (archived)' : '';
        const desc = p.description ? `  ${trim(p.description, 60)}` : '';
        return `${star} ${String(p.conversation_count).padStart(4)} convos  ${trim(p.name, 40).padEnd(42)}${desc}${archived}\n     ${p.uuid}`;
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
    return [
      `auth: ${auth}`,
      `cached conversations: ${total}`,
      `cached projects: ${projectCount}`,
      `cached project docs: ${docCount}`,
      `last conversation sync: ${last ? fmtDate(last) : 'never'}`,
      `last full sync run: ${lastFull ? fmtDate(lastFull) : 'never'}`,
    ].join('\n');
  },
};

const toolCalls: Tool = {
  name: 'library_tool_calls',
  description:
    'List tool calls recorded across all cached conversations. Filter by tool name or integration. Useful for "when did I use the X tool" queries.',
  inputSchema: {
    type: 'object',
    properties: {
      tool: { type: 'string', description: 'Filter by exact tool_name.' },
      integration: { type: 'string', description: 'Filter by integration_name.' },
      limit: { type: 'number', description: 'Max rows (default 25).' },
    },
  },
  handler: async (args) => {
    const hits = queryToolCalls({
      tool: typeof args.tool === 'string' ? args.tool : undefined,
      integration: typeof args.integration === 'string' ? args.integration : undefined,
      limit: args.limit !== undefined ? Number(args.limit) : undefined,
    });
    if (hits.length === 0) return 'No matching tool calls in cache.';
    const header = `${hits.length} tool call(s):`;
    const body = hits
      .map((h) => {
        const ts = fmtDate(h.created_at);
        const integ = h.integration_name ? ` [${h.integration_name}]` : '';
        return `  ${ts}  ${h.tool_name}${integ}  ${trim(h.conversation_name, 50)}\n        ${h.input_snippet}`;
      })
      .join('\n');
    return `${header}\n${body}`;
  },
};

const citations: Tool = {
  name: 'library_citations',
  description:
    'Search citations (web sources) saved in cached conversations. Filter by domain or search title/URL/site name.',
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', description: 'Exact site_domain to filter (e.g. "bbc.co.uk").' },
      query: { type: 'string', description: 'Substring search across title, URL, and site name.' },
      limit: { type: 'number', description: 'Max rows (default 25).' },
    },
  },
  handler: async (args) => {
    const hits = queryCitations({
      domain: typeof args.domain === 'string' ? args.domain : undefined,
      query: typeof args.query === 'string' ? args.query : undefined,
      limit: args.limit !== undefined ? Number(args.limit) : undefined,
    });
    if (hits.length === 0) return 'No matching citations in cache.';
    const header = `${hits.length} citation(s):`;
    const body = hits
      .map((h) => {
        const domain = h.site_domain ?? '(unknown domain)';
        const title = h.title ? trim(h.title, 60) : '(no title)';
        const url = h.url ? trim(h.url, 80) : '';
        return `  ${domain.padEnd(30)}  ${title}\n        ${url}\n        ${trim(h.conversation_name, 60)}  (${h.conversation_uuid})`;
      })
      .join('\n');
    return `${header}\n${body}`;
  },
};

export const tools: Tool[] = [sync, list, search, outline, get, doc, projects, status, toolCalls, citations];

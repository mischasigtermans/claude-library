import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { z } from 'zod';
import type { ClaudeCookies } from './auth.js';
import {
  OrgArraySchema,
  ConversationSummarySchema,
  ConversationFullSchema,
  ProjectArraySchema,
  ProjectExtendedSchema,
  ProjectFileSchema,
  ProjectDocArraySchema,
  OrganizationMemorySchema,
  ShareArraySchema,
} from './schemas.js';

export type {
  Org,
  ConversationSummary,
  ConversationFull,
  Message,
  MessageFile,
  Block,
  Project,
  ProjectExtended,
  ProjectDoc,
  OrganizationMemory,
  Share,
} from './schemas.js';

const BASE = 'https://claude.ai';
const FALLBACK_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.216 Electron/41.6.1 Safari/537.36';

function deriveClaudeDesktopUA(): string {
  const app = '/Applications/Claude.app';
  const fw = `${app}/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework`;
  if (!existsSync(fw)) return FALLBACK_UA;
  try {
    const out = execSync(`strings '${fw}' | grep -m 1 -E 'Chrome/[0-9.]+ Electron/[0-9.]+'`, {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
    const match = out.match(/Chrome\/(\d+\.\d+\.\d+\.\d+) Electron\/(\d+\.\d+\.\d+)/);
    if (!match) return FALLBACK_UA;
    const [, chrome, electron] = match;
    let claudeVer = '';
    try {
      claudeVer = execFileSync(
        '/usr/libexec/PlistBuddy',
        ['-c', 'Print :CFBundleShortVersionString', `${app}/Contents/Info.plist`],
        { encoding: 'utf8' },
      ).trim();
    } catch {}
    const claudePart = claudeVer ? `Claude/${claudeVer} ` : '';
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ${claudePart}Chrome/${chrome} Electron/${electron} Safari/537.36`;
  } catch {
    return FALLBACK_UA;
  }
}

const UA = deriveClaudeDesktopUA();

function cookieHeader(c: ClaudeCookies): string {
  const parts = [`sessionKey=${c.sessionKey}`];
  if (c.cfClearance) parts.push(`cf_clearance=${c.cfClearance}`);
  return parts.join('; ');
}

export class SessionExpiredError extends Error {
  constructor() {
    super(
      'library: Claude Desktop session expired. Open Claude Desktop, make sure you are signed in, then retry. (The session cookie used by library is refreshed when Desktop opens.)',
    );
    this.name = 'SessionExpiredError';
  }
}

async function fetchOnce(c: ClaudeCookies, path: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    headers: {
      Cookie: cookieHeader(c),
      'User-Agent': UA,
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: `${BASE}/`,
    },
  });
}

async function call<T>(c: ClaudeCookies, path: string, schema: z.ZodType<T>): Promise<T> {
  let r = await fetchOnce(c, path);
  if (r.status === 403) r = await fetchOnce(c, path);
  if (r.status === 401) throw new SessionExpiredError();
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`library: ${r.status} ${r.statusText} on ${path}\n${body.slice(0, 300)}`);
  }
  return schema.parse(await r.json());
}

export function listOrgs(c: ClaudeCookies) {
  return call(c, '/api/organizations', OrgArraySchema);
}

export async function listConversationsPage(
  c: ClaudeCookies,
  orgId: string,
  opts: { limit?: number; offset?: number } = {},
) {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  return call(
    c,
    `/api/organizations/${orgId}/chat_conversations?limit=${limit}&offset=${offset}`,
    ConversationSummarySchema.array(),
  );
}

export async function* iterateConversations(
  c: ClaudeCookies,
  orgId: string,
  opts: { pageSize?: number; stopWhen?: (page: import('./schemas.js').ConversationSummary[]) => boolean } = {},
): AsyncGenerator<import('./schemas.js').ConversationSummary> {
  const pageSize = opts.pageSize ?? 100;
  let offset = 0;
  while (true) {
    const page = await listConversationsPage(c, orgId, { limit: pageSize, offset });
    for (const conv of page) yield conv;
    if (page.length < pageSize) return;
    if (opts.stopWhen?.(page)) return;
    offset += pageSize;
  }
}

export function getConversation(
  c: ClaudeCookies,
  orgId: string,
  convoId: string,
) {
  return call(
    c,
    `/api/organizations/${orgId}/chat_conversations/${convoId}?tree=True&rendering_mode=messages&render_all_tools=true`,
    ConversationFullSchema,
  );
}

export function listProjects(c: ClaudeCookies, orgId: string) {
  return call(c, `/api/organizations/${orgId}/projects`, ProjectArraySchema);
}

export function getProject(
  c: ClaudeCookies,
  orgId: string,
  projectId: string,
) {
  return call(c, `/api/organizations/${orgId}/projects/${projectId}`, ProjectExtendedSchema);
}

export async function listProjectFiles(
  c: ClaudeCookies,
  orgId: string,
  projectId: string,
): Promise<Array<{ uuid: string; file_name?: string; raw: unknown }>> {
  const items = await call(
    c,
    `/api/organizations/${orgId}/projects/${projectId}/files`,
    ProjectFileSchema.array(),
  );
  const results: Array<{ uuid: string; file_name?: string; raw: unknown }> = [];
  for (const item of items) {
    if (!item.uuid) {
      process.stderr.write(`library: project_files entry missing uuid, skipped (project ${projectId})\n`);
      continue;
    }
    results.push({ uuid: item.uuid, file_name: item.file_name, raw: item });
  }
  return results;
}

export function listProjectDocs(
  c: ClaudeCookies,
  orgId: string,
  projectId: string,
) {
  return call(c, `/api/organizations/${orgId}/projects/${projectId}/docs`, ProjectDocArraySchema);
}

export function listShares(c: ClaudeCookies, orgId: string) {
  return call(c, `/api/organizations/${orgId}/shares`, ShareArraySchema);
}

export function getOrgMemory(c: ClaudeCookies, orgId: string) {
  return call(c, `/api/organizations/${orgId}/memory`, OrganizationMemorySchema);
}

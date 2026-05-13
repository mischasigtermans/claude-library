import type { ClaudeCookies } from './auth.js';

const BASE = 'https://claude.ai';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

async function call<T>(c: ClaudeCookies, path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    headers: {
      Cookie: cookieHeader(c),
      'User-Agent': UA,
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: `${BASE}/`,
    },
  });
  if (r.status === 401) throw new SessionExpiredError();
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`library: ${r.status} ${r.statusText} on ${path}\n${body.slice(0, 300)}`);
  }
  return (await r.json()) as T;
}

export interface Org {
  uuid: string;
  name: string;
  capabilities?: string[];
}

export interface ConversationSummary {
  uuid: string;
  name: string;
  summary?: string;
  created_at: string;
  updated_at: string;
  model?: string | null;
  is_starred?: boolean;
  project_uuid?: string | null;
  is_temporary?: boolean;
  current_leaf_message_uuid?: string;
  platform?: string;
  session_id?: string | null;
  settings?: Record<string, unknown>;
  project?: { uuid: string; name: string } | null;
}

export interface MessageFileAsset {
  url?: string;
  primary_color?: string;
  image_width?: number;
  image_height?: number;
}

export interface MessageFile {
  uuid: string;
  file_uuid?: string;
  file_kind?: string;
  file_name?: string;
  thumbnail_url?: string;
  preview_url?: string;
  thumbnail_asset?: MessageFileAsset;
  preview_asset?: MessageFileAsset;
  created_at?: string;
}

export interface Message {
  uuid: string;
  text: string;
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  sender: 'human' | 'assistant';
  index?: number;
  created_at: string;
  updated_at: string;
  parent_message_uuid?: string;
  attachments?: unknown[];
  files?: MessageFile[];
  sync_sources?: unknown[];
  truncated?: boolean;
  input_mode?: string;
  stop_reason?: string | null;
  compaction_summary?: string | null;
}

export interface ConversationFull extends ConversationSummary {
  chat_messages: Message[];
}

export function listOrgs(c: ClaudeCookies): Promise<Org[]> {
  return call<Org[]>(c, '/api/organizations');
}

export async function listConversationsPage(
  c: ClaudeCookies,
  orgId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<ConversationSummary[]> {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  return call<ConversationSummary[]>(
    c,
    `/api/organizations/${orgId}/chat_conversations?limit=${limit}&offset=${offset}`,
  );
}

export async function* iterateConversations(
  c: ClaudeCookies,
  orgId: string,
  opts: { pageSize?: number; stopWhen?: (page: ConversationSummary[]) => boolean } = {},
): AsyncGenerator<ConversationSummary> {
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
): Promise<ConversationFull> {
  return call<ConversationFull>(
    c,
    `/api/organizations/${orgId}/chat_conversations/${convoId}?tree=True&rendering_mode=messages&render_all_tools=true`,
  );
}

export interface Project {
  uuid: string;
  name: string;
  description?: string;
  is_starred?: boolean;
  is_starter_project?: boolean;
  created_at: string;
  updated_at?: string;
  archived_at?: string | null;
}

export interface ProjectExtended extends Project {
  prompt_template?: string;
  is_harmony_project?: boolean;
  docs_count?: number;
  files_count?: number;
}

export function listProjects(c: ClaudeCookies, orgId: string): Promise<Project[]> {
  return call<Project[]>(c, `/api/organizations/${orgId}/projects`);
}

export function getProject(
  c: ClaudeCookies,
  orgId: string,
  projectId: string,
): Promise<ProjectExtended> {
  return call<ProjectExtended>(c, `/api/organizations/${orgId}/projects/${projectId}`);
}

export async function listProjectFiles(
  c: ClaudeCookies,
  orgId: string,
  projectId: string,
): Promise<Array<{ uuid: string; file_name?: string; raw: unknown }>> {
  const items = await call<unknown[]>(c, `/api/organizations/${orgId}/projects/${projectId}/files`);
  const results: Array<{ uuid: string; file_name?: string; raw: unknown }> = [];
  for (const item of items) {
    const obj = item as Record<string, unknown>;
    if (!obj.uuid) {
      process.stderr.write(`library: project_files entry missing uuid, skipped (project ${projectId})\n`);
      continue;
    }
    results.push({ uuid: obj.uuid as string, file_name: obj.file_name as string | undefined, raw: item });
  }
  return results;
}

export interface ProjectDoc {
  uuid: string;
  file_name: string;
  content: string;
  project_uuid: string;
  created_at: string;
  estimated_token_count?: number;
}

export function listProjectDocs(
  c: ClaudeCookies,
  orgId: string,
  projectId: string,
): Promise<ProjectDoc[]> {
  return call<ProjectDoc[]>(c, `/api/organizations/${orgId}/projects/${projectId}/docs`);
}

export interface Share {
  uuid: string;
  snapshot_name?: string;
  conversation_uuid?: string | null;
  project_uuid?: string | null;
  last_message_index?: number | null;
  created_at?: string;
  updated_at?: string;
}

export function listShares(c: ClaudeCookies, orgId: string): Promise<Share[]> {
  return call<Share[]>(c, `/api/organizations/${orgId}/shares`);
}

export interface OrganizationMemory {
  memory: string;
  controls: unknown;
  updated_at: string;
}

export function getOrgMemory(c: ClaudeCookies, orgId: string): Promise<OrganizationMemory> {
  return call<OrganizationMemory>(c, `/api/organizations/${orgId}/memory`);
}

export async function fetchFileBlob(
  c: ClaudeCookies,
  orgId: string,
  fileUuid: string,
  variant: 'thumbnail' | 'preview',
): Promise<Buffer> {
  const r = await fetch(`${BASE}/api/${orgId}/files/${fileUuid}/${variant}`, {
    headers: {
      Cookie: cookieHeader(c),
      'User-Agent': UA,
      Referer: `${BASE}/`,
    },
  });
  if (r.status === 401) throw new SessionExpiredError();
  if (!r.ok) throw new Error(`library: ${r.status} on file blob ${fileUuid}/${variant}`);
  return Buffer.from(await r.arrayBuffer());
}

import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import type {
  ConversationFull,
  ConversationSummary,
  Message,
  MessageFile,
  Project,
  ProjectDoc,
} from './api.js';

const CACHE_DIR = join(homedir(), '.claude', 'library');
const DB_PATH = join(CACHE_DIR, 'library.db');
const LEGACY_DIR = join(homedir(), '.claude', 'hansard');
const LEGACY_DB = join(LEGACY_DIR, 'hansard.db');

function migrateFromHansard(): void {
  if (existsSync(DB_PATH) || !existsSync(LEGACY_DB)) return;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    renameSync(LEGACY_DB, DB_PATH);
    for (const ext of ['-shm', '-wal']) {
      const src = LEGACY_DB + ext;
      if (existsSync(src)) renameSync(src, DB_PATH + ext);
    }
    process.stderr.write('library: migrated cache from ~/.claude/hansard/ (legacy hansard plugin layout)\n');
  } catch (err) {
    process.stderr.write(`library: migrate from hansard failed, starting fresh (${err instanceof Error ? err.message : String(err)})\n`);
  }
}

function open(): Database.Database {
  migrateFromHansard();
  mkdirSync(CACHE_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      uuid TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      summary TEXT,
      model TEXT,
      is_starred INTEGER NOT NULL DEFAULT 0,
      project_uuid TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      messages_synced INTEGER NOT NULL DEFAULT 0,
      messages_synced_for TEXT
    );
    CREATE INDEX IF NOT EXISTS conversations_updated ON conversations(updated_at DESC);
    CREATE INDEX IF NOT EXISTS conversations_project ON conversations(project_uuid);

    CREATE TABLE IF NOT EXISTS messages (
      uuid TEXT PRIMARY KEY,
      conversation_uuid TEXT NOT NULL,
      idx INTEGER NOT NULL,
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(conversation_uuid) REFERENCES conversations(uuid) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS messages_convo ON messages(conversation_uuid, idx);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text, conversation_uuid UNINDEXED, message_uuid UNINDEXED, sender UNINDEXED
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(text, conversation_uuid, message_uuid, sender)
      VALUES (new.text, new.conversation_uuid, new.uuid, new.sender);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE message_uuid = old.uuid;
    END;

    CREATE TABLE IF NOT EXISTS projects (
      uuid TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      is_starred INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      archived_at TEXT,
      synced_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_docs (
      uuid TEXT PRIMARY KEY,
      project_uuid TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content TEXT NOT NULL,
      estimated_tokens INTEGER,
      created_at TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS project_docs_project ON project_docs(project_uuid);

    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      content, doc_uuid UNINDEXED, project_uuid UNINDEXED, file_name UNINDEXED
    );

    CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON project_docs BEGIN
      INSERT INTO docs_fts(content, doc_uuid, project_uuid, file_name)
      VALUES (new.content, new.uuid, new.project_uuid, new.file_name);
    END;
    CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON project_docs BEGIN
      DELETE FROM docs_fts WHERE doc_uuid = old.uuid;
    END;

    CREATE TABLE IF NOT EXISTS message_blocks (
      uuid TEXT PRIMARY KEY,
      message_uuid TEXT NOT NULL,
      position INTEGER NOT NULL,
      type TEXT NOT NULL,
      text TEXT,
      tool_use_id TEXT,
      tool_name TEXT,
      tool_input_json TEXT,
      tool_result_text TEXT,
      is_error INTEGER NOT NULL DEFAULT 0,
      integration_name TEXT,
      start_timestamp TEXT,
      stop_timestamp TEXT,
      FOREIGN KEY(message_uuid) REFERENCES messages(uuid) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS message_blocks_msg ON message_blocks(message_uuid, position);
    CREATE INDEX IF NOT EXISTS message_blocks_tool ON message_blocks(tool_name) WHERE tool_name IS NOT NULL;

    CREATE TABLE IF NOT EXISTS citations (
      uuid TEXT PRIMARY KEY,
      message_uuid TEXT NOT NULL,
      block_position INTEGER NOT NULL,
      title TEXT,
      url TEXT,
      site_domain TEXT,
      site_name TEXT,
      origin_tool_name TEXT,
      start_index INTEGER,
      end_index INTEGER,
      FOREIGN KEY(message_uuid) REFERENCES messages(uuid) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS citations_msg ON citations(message_uuid);
    CREATE INDEX IF NOT EXISTS citations_domain ON citations(site_domain);

    CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
      text, message_uuid UNINDEXED, block_uuid UNINDEXED, type UNINDEXED
    );
    CREATE TRIGGER IF NOT EXISTS message_blocks_ai AFTER INSERT ON message_blocks BEGIN
      INSERT INTO blocks_fts(text, message_uuid, block_uuid, type)
      VALUES (coalesce(new.text, new.tool_result_text, ''), new.message_uuid, new.uuid, new.type);
    END;
    CREATE TRIGGER IF NOT EXISTS message_blocks_ad AFTER DELETE ON message_blocks BEGIN
      DELETE FROM blocks_fts WHERE block_uuid = old.uuid;
    END;

    CREATE TABLE IF NOT EXISTS message_files (
      uuid TEXT PRIMARY KEY,
      message_uuid TEXT NOT NULL,
      file_kind TEXT,
      file_name TEXT,
      thumbnail_url TEXT,
      preview_url TEXT,
      primary_color TEXT,
      width INTEGER,
      height INTEGER,
      created_at TEXT,
      FOREIGN KEY(message_uuid) REFERENCES messages(uuid) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS message_files_msg ON message_files(message_uuid);
    CREATE INDEX IF NOT EXISTS message_files_kind ON message_files(file_kind);

    CREATE TABLE IF NOT EXISTS message_attachments (
      uuid TEXT PRIMARY KEY,
      message_uuid TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      FOREIGN KEY(message_uuid) REFERENCES messages(uuid) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS message_attachments_msg ON message_attachments(message_uuid);

    CREATE TABLE IF NOT EXISTS file_blobs (
      file_uuid TEXT NOT NULL,
      variant TEXT NOT NULL,
      bytes BLOB NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (file_uuid, variant)
    );
  `);
  // Backfill columns added after v0.1.0.
  const convoCols = db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[];
  const hasConvoCol = (n: string) => convoCols.some((c) => c.name === n);
  if (!hasConvoCol('messages_synced_for')) db.exec('ALTER TABLE conversations ADD COLUMN messages_synced_for TEXT');
  if (!hasConvoCol('is_temporary')) db.exec('ALTER TABLE conversations ADD COLUMN is_temporary INTEGER NOT NULL DEFAULT 0');
  if (!hasConvoCol('current_leaf_uuid')) db.exec('ALTER TABLE conversations ADD COLUMN current_leaf_uuid TEXT');
  if (!hasConvoCol('platform')) db.exec('ALTER TABLE conversations ADD COLUMN platform TEXT');
  if (!hasConvoCol('session_id')) db.exec('ALTER TABLE conversations ADD COLUMN session_id TEXT');
  if (!hasConvoCol('settings_json')) db.exec('ALTER TABLE conversations ADD COLUMN settings_json TEXT');

  const msgCols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
  const hasMsgCol = (n: string) => msgCols.some((c) => c.name === n);
  if (!hasMsgCol('parent_uuid')) db.exec('ALTER TABLE messages ADD COLUMN parent_uuid TEXT');
  if (!hasMsgCol('input_mode')) db.exec('ALTER TABLE messages ADD COLUMN input_mode TEXT');
  if (!hasMsgCol('stop_reason')) db.exec('ALTER TABLE messages ADD COLUMN stop_reason TEXT');
  if (!hasMsgCol('truncated')) db.exec('ALTER TABLE messages ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0');
  if (!hasMsgCol('compaction_summary')) db.exec('ALTER TABLE messages ADD COLUMN compaction_summary TEXT');

  return db;
}

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (!_db) _db = open();
  return _db;
}

function messageText(m: Message): string {
  if (m.text && m.text.length > 0) return m.text;
  if (m.content) {
    return m.content
      .map((c) => (c.type === 'text' ? c.text ?? '' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function upsertConversation(orgId: string, c: ConversationSummary): void {
  db()
    .prepare(
      `INSERT INTO conversations (uuid, org_id, name, summary, model, is_starred, project_uuid, created_at, updated_at, synced_at,
         is_temporary, current_leaf_uuid, platform, session_id, settings_json)
       VALUES (@uuid, @org_id, @name, @summary, @model, @is_starred, @project_uuid, @created_at, @updated_at, @synced_at,
         @is_temporary, @current_leaf_uuid, @platform, @session_id, @settings_json)
       ON CONFLICT(uuid) DO UPDATE SET
         name=excluded.name, summary=excluded.summary, model=excluded.model,
         is_starred=excluded.is_starred, project_uuid=excluded.project_uuid,
         updated_at=excluded.updated_at, synced_at=excluded.synced_at,
         is_temporary=excluded.is_temporary, current_leaf_uuid=excluded.current_leaf_uuid,
         platform=excluded.platform, session_id=excluded.session_id, settings_json=excluded.settings_json`,
    )
    .run({
      uuid: c.uuid,
      org_id: orgId,
      name: c.name,
      summary: c.summary ?? null,
      model: c.model ?? null,
      is_starred: c.is_starred ? 1 : 0,
      project_uuid: c.project_uuid ?? null,
      created_at: c.created_at,
      updated_at: c.updated_at,
      synced_at: new Date().toISOString(),
      is_temporary: c.is_temporary ? 1 : 0,
      current_leaf_uuid: c.current_leaf_message_uuid ?? null,
      platform: c.platform ?? null,
      session_id: c.session_id ?? null,
      settings_json: c.settings ? JSON.stringify(c.settings) : null,
    });
}

function upsertMessageBlocks(msgs: Message[]): void {
  const insBlock = db().prepare(
    `INSERT INTO message_blocks (uuid, message_uuid, position, type, text, tool_use_id, tool_name,
       tool_input_json, tool_result_text, is_error, integration_name, start_timestamp, stop_timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insCitation = db().prepare(
    `INSERT OR REPLACE INTO citations (uuid, message_uuid, block_position, title, url, site_domain,
       site_name, origin_tool_name, start_index, end_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const m of msgs) {
    if (!m.content || m.content.length === 0) continue;
    db().prepare('DELETE FROM message_blocks WHERE message_uuid = ?').run(m.uuid);
    m.content.forEach((b, pos) => {
      const blockUuid = `${m.uuid}-${pos}`;
      let text: string | null = null;
      let toolUseId: string | null = null;
      let toolName: string | null = null;
      let toolInputJson: string | null = null;
      let toolResultText: string | null = null;
      let isError = 0;

      if (b.type === 'text' || b.type === 'thinking') {
        text = (b.text as string | undefined) ?? null;
      } else if (b.type === 'tool_use') {
        toolUseId = (b.id as string | undefined) ?? null;
        toolName = (b.name as string | undefined) ?? null;
        toolInputJson = b.input !== undefined ? JSON.stringify(b.input) : null;
      } else if (b.type === 'tool_result') {
        toolUseId = (b.tool_use_id as string | undefined) ?? null;
        toolName = (b.name as string | undefined) ?? null;
        isError = (b.is_error as boolean | undefined) ? 1 : 0;
        const resultContent = b.content as Array<{ type: string; text?: string }> | undefined;
        if (resultContent) {
          toolResultText = resultContent
            .filter((rc) => rc.type === 'text')
            .map((rc) => rc.text ?? '')
            .join('\n') || null;
        }
      }

      insBlock.run(
        blockUuid, m.uuid, pos, b.type,
        text, toolUseId, toolName, toolInputJson, toolResultText,
        isError,
        (b.integration_name as string | undefined) ?? null,
        (b.start_timestamp as string | undefined) ?? null,
        (b.stop_timestamp as string | undefined) ?? null,
      );

      if (b.type === 'text') {
        const citations = b.citations as Array<Record<string, unknown>> | undefined;
        if (citations) {
          for (const cit of citations) {
            const meta = (cit.metadata as Record<string, unknown> | undefined) ?? {};
            insCitation.run(
              cit.uuid as string,
              m.uuid,
              pos,
              (cit.title as string | undefined) ?? null,
              (cit.url as string | undefined) ?? null,
              (meta.site_domain as string | undefined) ?? null,
              (meta.site_name as string | undefined) ?? null,
              (cit.origin_tool_name as string | undefined) ?? null,
              (cit.start_index as number | undefined) ?? null,
              (cit.end_index as number | undefined) ?? null,
            );
          }
        }
      }
    });
  }
}

export function upsertMessageFiles(messageUuid: string, files: MessageFile[]): void {
  db().prepare('DELETE FROM message_files WHERE message_uuid = ?').run(messageUuid);
  if (files.length === 0) return;
  const ins = db().prepare(
    `INSERT INTO message_files (uuid, message_uuid, file_kind, file_name, thumbnail_url, preview_url,
       primary_color, width, height, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const f of files) {
    const asset = f.thumbnail_asset ?? {};
    ins.run(
      f.uuid ?? f.file_uuid,
      messageUuid,
      f.file_kind ?? null,
      f.file_name ?? null,
      f.thumbnail_url ?? null,
      f.preview_url ?? null,
      asset.primary_color ?? null,
      asset.image_width ?? null,
      asset.image_height ?? null,
      f.created_at ?? null,
    );
  }
}

export function upsertMessageAttachments(messageUuid: string, atts: unknown[]): void {
  db().prepare('DELETE FROM message_attachments WHERE message_uuid = ?').run(messageUuid);
  if (atts.length === 0) return;
  const ins = db().prepare(
    'INSERT INTO message_attachments (uuid, message_uuid, raw_json) VALUES (?, ?, ?)',
  );
  atts.forEach((a, i) => {
    const att = a as Record<string, unknown>;
    const uuid = (att.uuid as string | undefined) ?? `${messageUuid}-att-${i}`;
    ins.run(uuid, messageUuid, JSON.stringify(a));
  });
}

export function getFileBlob(fileUuid: string, variant: string): Buffer | undefined {
  const row = db()
    .prepare('SELECT bytes FROM file_blobs WHERE file_uuid = ? AND variant = ?')
    .get(fileUuid, variant) as { bytes: Buffer } | undefined;
  return row?.bytes;
}

export function setFileBlob(fileUuid: string, variant: string, bytes: Buffer): void {
  db()
    .prepare(
      'INSERT INTO file_blobs (file_uuid, variant, bytes, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(file_uuid, variant) DO UPDATE SET bytes = excluded.bytes, fetched_at = excluded.fetched_at',
    )
    .run(fileUuid, variant, bytes, new Date().toISOString());
}

export interface FileBlobTarget {
  file_uuid: string;
  message_uuid: string;
  conversation_uuid: string;
  file_kind: string | null;
}

export function listFilesNeedingBlob(opts: {
  variant: string;
  kinds?: string[];
  convoUuid?: string;
  limit?: number;
} = { variant: 'thumbnail' }): FileBlobTarget[] {
  const where: string[] = ['NOT EXISTS (SELECT 1 FROM file_blobs fb WHERE fb.file_uuid = mf.uuid AND fb.variant = ?)'];
  const args: unknown[] = [opts.variant];
  if (opts.kinds && opts.kinds.length > 0) {
    where.push(`mf.file_kind IN (${opts.kinds.map(() => '?').join(',')})`);
    args.push(...opts.kinds);
  }
  if (opts.convoUuid) {
    where.push('m.conversation_uuid = ?');
    args.push(opts.convoUuid);
  }
  args.push(opts.limit ?? 50);
  return db()
    .prepare(
      `SELECT mf.uuid AS file_uuid, mf.message_uuid, m.conversation_uuid, mf.file_kind
       FROM message_files mf
       JOIN messages m ON m.uuid = mf.message_uuid
       JOIN conversations c ON c.uuid = m.conversation_uuid
       WHERE ${where.join(' AND ')}
       ORDER BY c.updated_at DESC LIMIT ?`,
    )
    .all(...args) as FileBlobTarget[];
}

export function upsertMessages(convo: ConversationFull): void {
  const tx = db().transaction((msgs: Message[]) => {
    db().prepare('DELETE FROM messages WHERE conversation_uuid = ?').run(convo.uuid);
    const ins = db().prepare(
      `INSERT INTO messages (uuid, conversation_uuid, idx, sender, text, created_at,
         parent_uuid, input_mode, stop_reason, truncated, compaction_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    msgs.forEach((m, i) => {
      ins.run(
        m.uuid, convo.uuid, m.index ?? i, m.sender, messageText(m), m.created_at,
        m.parent_message_uuid ?? null,
        m.input_mode ?? null,
        m.stop_reason ?? null,
        m.truncated ? 1 : 0,
        m.compaction_summary ?? null,
      );
    });
    upsertMessageBlocks(msgs);
    for (const m of msgs) {
      if (m.files && m.files.length > 0) upsertMessageFiles(m.uuid, m.files);
      if (m.attachments && m.attachments.length > 0) upsertMessageAttachments(m.uuid, m.attachments);
    }
    db()
      .prepare(
        'UPDATE conversations SET messages_synced = 1, messages_synced_for = ?, synced_at = ? WHERE uuid = ?',
      )
      .run(convo.updated_at, new Date().toISOString(), convo.uuid);
  });
  tx(convo.chat_messages);
}

export function upsertProject(orgId: string, p: Project): void {
  db()
    .prepare(
      `INSERT INTO projects (uuid, org_id, name, description, is_starred, created_at, updated_at, archived_at, synced_at)
       VALUES (@uuid, @org_id, @name, @description, @is_starred, @created_at, @updated_at, @archived_at, @synced_at)
       ON CONFLICT(uuid) DO UPDATE SET
         name=excluded.name, description=excluded.description, is_starred=excluded.is_starred,
         updated_at=excluded.updated_at, archived_at=excluded.archived_at, synced_at=excluded.synced_at`,
    )
    .run({
      uuid: p.uuid,
      org_id: orgId,
      name: p.name,
      description: p.description ?? null,
      is_starred: p.is_starred ? 1 : 0,
      created_at: p.created_at,
      updated_at: p.updated_at ?? null,
      archived_at: p.archived_at ?? null,
      synced_at: new Date().toISOString(),
    });
}

export function getConversationFreshness(uuid: string): { updated_at: string; messages_synced_for: string | null } | undefined {
  return db()
    .prepare('SELECT updated_at, messages_synced_for FROM conversations WHERE uuid = ?')
    .get(uuid) as { updated_at: string; messages_synced_for: string | null } | undefined;
}

export function setMeta(key: string, value: string): void {
  db()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export function getMeta(key: string): string | undefined {
  const row = db().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export interface CachedConversation {
  uuid: string;
  org_id: string;
  name: string;
  summary: string | null;
  model: string | null;
  is_starred: number;
  project_uuid: string | null;
  created_at: string;
  updated_at: string;
  messages_synced: number;
  message_count?: number;
  is_temporary?: number;
  current_leaf_uuid?: string | null;
  platform?: string | null;
  session_id?: string | null;
  settings_json?: string | null;
}

export function listCached(opts: {
  limit?: number;
  orgId?: string;
  projectUuid?: string;
} = {}): CachedConversation[] {
  const limit = opts.limit ?? 50;
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.orgId) {
    where.push('c.org_id = ?');
    args.push(opts.orgId);
  }
  if (opts.projectUuid) {
    where.push('c.project_uuid = ?');
    args.push(opts.projectUuid);
  }
  args.push(limit);
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db()
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_uuid = c.uuid) AS message_count
       FROM conversations c ${whereClause}
       ORDER BY c.updated_at DESC LIMIT ?`,
    )
    .all(...args) as CachedConversation[];
}

export function getCached(uuid: string): CachedConversation | undefined {
  return db()
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_uuid = c.uuid) AS message_count
       FROM conversations c WHERE uuid = ?`,
    )
    .get(uuid) as CachedConversation | undefined;
}

export interface CachedMessage {
  uuid: string;
  idx: number;
  sender: string;
  text: string;
  created_at: string;
  parent_uuid?: string | null;
  input_mode?: string | null;
  stop_reason?: string | null;
  truncated?: number;
  compaction_summary?: string | null;
}

export function getMessages(convoUuid: string): CachedMessage[] {
  return db()
    .prepare(
      `SELECT uuid, idx, sender, text, created_at,
         parent_uuid, input_mode, stop_reason, truncated, compaction_summary
       FROM messages WHERE conversation_uuid = ? ORDER BY idx ASC`,
    )
    .all(convoUuid) as CachedMessage[];
}

export interface SearchHit {
  conversation_uuid: string;
  conversation_name: string;
  message_uuid: string;
  sender: string;
  snippet: string;
  rank: number;
}

export function search(query: string, limit = 20): SearchHit[] {
  return db()
    .prepare(
      `SELECT
         f.conversation_uuid AS conversation_uuid,
         c.name AS conversation_name,
         f.message_uuid AS message_uuid,
         f.sender AS sender,
         snippet(messages_fts, 0, '«', '»', '…', 16) AS snippet,
         bm25(messages_fts) AS rank
       FROM messages_fts f
       JOIN conversations c ON c.uuid = f.conversation_uuid
       WHERE messages_fts MATCH ?
       ORDER BY rank LIMIT ?`,
    )
    .all(query, limit) as SearchHit[];
}

export function lastSyncedAt(orgId?: string): string | null {
  const where = orgId ? 'WHERE org_id = ?' : '';
  const args = orgId ? [orgId] : [];
  const row = db()
    .prepare(`SELECT MAX(synced_at) AS m FROM conversations ${where}`)
    .get(...args) as { m: string | null };
  return row.m;
}

export function totalConversations(orgId?: string): number {
  const where = orgId ? 'WHERE org_id = ?' : '';
  const args = orgId ? [orgId] : [];
  const row = db()
    .prepare(`SELECT COUNT(*) AS n FROM conversations ${where}`)
    .get(...args) as { n: number };
  return row.n;
}

export interface ProjectWithCount {
  uuid: string;
  org_id: string;
  name: string;
  description: string | null;
  is_starred: number;
  archived_at: string | null;
  created_at: string;
  conversation_count: number;
}

export function listProjectsCached(orgId?: string): ProjectWithCount[] {
  const where = orgId ? 'WHERE p.org_id = ?' : '';
  const args = orgId ? [orgId] : [];
  return db()
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM conversations c WHERE c.project_uuid = p.uuid) AS conversation_count
       FROM projects p ${where}
       ORDER BY p.is_starred DESC, conversation_count DESC, p.name ASC`,
    )
    .all(...args) as ProjectWithCount[];
}

export function replaceProjectDocs(projectUuid: string, docs: ProjectDoc[]): void {
  const tx = db().transaction((items: ProjectDoc[]) => {
    db().prepare('DELETE FROM project_docs WHERE project_uuid = ?').run(projectUuid);
    const ins = db().prepare(
      'INSERT INTO project_docs (uuid, project_uuid, file_name, content, estimated_tokens, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const now = new Date().toISOString();
    for (const d of items) {
      ins.run(
        d.uuid,
        projectUuid,
        d.file_name,
        d.content,
        d.estimated_token_count ?? null,
        d.created_at,
        now,
      );
    }
  });
  tx(docs);
}

export interface CachedDoc {
  uuid: string;
  project_uuid: string;
  file_name: string;
  content: string;
  estimated_tokens: number | null;
  created_at: string;
  synced_at: string;
  project_name?: string;
}

export function getDoc(uuid: string): CachedDoc | undefined {
  return db()
    .prepare(
      `SELECT d.*, p.name AS project_name
       FROM project_docs d LEFT JOIN projects p ON p.uuid = d.project_uuid
       WHERE d.uuid = ?`,
    )
    .get(uuid) as CachedDoc | undefined;
}

export function totalDocs(): number {
  const row = db().prepare('SELECT COUNT(*) AS n FROM project_docs').get() as { n: number };
  return row.n;
}

export interface DocSearchHit {
  doc_uuid: string;
  file_name: string;
  project_uuid: string;
  project_name: string | null;
  snippet: string;
  rank: number;
}

export function searchDocs(query: string, limit = 10): DocSearchHit[] {
  return db()
    .prepare(
      `SELECT
         f.doc_uuid AS doc_uuid,
         f.file_name AS file_name,
         f.project_uuid AS project_uuid,
         p.name AS project_name,
         snippet(docs_fts, 0, '«', '»', '…', 16) AS snippet,
         bm25(docs_fts) AS rank
       FROM docs_fts f
       LEFT JOIN projects p ON p.uuid = f.project_uuid
       WHERE docs_fts MATCH ?
       ORDER BY rank LIMIT ?`,
    )
    .all(query, limit) as DocSearchHit[];
}

export function findProjectByName(name: string): ProjectWithCount | undefined {
  const lower = name.toLowerCase();
  return db()
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM conversations c WHERE c.project_uuid = p.uuid) AS conversation_count
       FROM projects p
       WHERE LOWER(p.name) = ? OR p.uuid = ?
       LIMIT 1`,
    )
    .get(lower, name) as ProjectWithCount | undefined;
}

export interface ToolCallHit {
  created_at: string;
  tool_name: string;
  integration_name: string | null;
  conversation_name: string;
  conversation_uuid: string;
  input_snippet: string;
}

export function queryToolCalls(opts: { tool?: string; integration?: string; limit?: number } = {}): ToolCallHit[] {
  const where: string[] = ["b.type = 'tool_use'"];
  const args: unknown[] = [];
  if (opts.tool) { where.push('b.tool_name = ?'); args.push(opts.tool); }
  if (opts.integration) { where.push('b.integration_name = ?'); args.push(opts.integration); }
  args.push(opts.limit ?? 25);
  return db()
    .prepare(
      `SELECT m.created_at, b.tool_name, b.integration_name, c.name AS conversation_name, c.uuid AS conversation_uuid,
         substr(coalesce(b.tool_input_json, ''), 1, 80) AS input_snippet
       FROM message_blocks b
       JOIN messages m ON m.uuid = b.message_uuid
       JOIN conversations c ON c.uuid = m.conversation_uuid
       WHERE ${where.join(' AND ')}
       ORDER BY m.created_at DESC LIMIT ?`,
    )
    .all(...args) as ToolCallHit[];
}

export interface CitationHit {
  site_domain: string | null;
  title: string | null;
  url: string | null;
  conversation_name: string;
  conversation_uuid: string;
}

export function queryCitations(opts: { domain?: string; query?: string; limit?: number } = {}): CitationHit[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.domain) { where.push('ci.site_domain = ?'); args.push(opts.domain); }
  if (opts.query) {
    where.push("(ci.title LIKE ? OR ci.url LIKE ? OR ci.site_name LIKE ?)");
    const pat = `%${opts.query}%`;
    args.push(pat, pat, pat);
  }
  args.push(opts.limit ?? 25);
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db()
    .prepare(
      `SELECT ci.site_domain, ci.title, ci.url, c.name AS conversation_name, c.uuid AS conversation_uuid
       FROM citations ci
       JOIN messages m ON m.uuid = ci.message_uuid
       JOIN conversations c ON c.uuid = m.conversation_uuid
       ${whereClause}
       ORDER BY m.created_at DESC LIMIT ?`,
    )
    .all(...args) as CitationHit[];
}

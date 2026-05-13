import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type {
  ConversationFull,
  ConversationSummary,
  Message,
  Project,
  ProjectDoc,
} from './api.js';

const CACHE_DIR = join(homedir(), '.claude', 'library');
const DB_PATH = join(CACHE_DIR, 'library.db');

function open(): Database.Database {
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
  `);
  // Backfill columns added after v0.1.0.
  const cols = db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
  if (!cols.some((c) => c.name === 'messages_synced_for')) {
    db.exec('ALTER TABLE conversations ADD COLUMN messages_synced_for TEXT');
  }
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
      `INSERT INTO conversations (uuid, org_id, name, summary, model, is_starred, project_uuid, created_at, updated_at, synced_at)
       VALUES (@uuid, @org_id, @name, @summary, @model, @is_starred, @project_uuid, @created_at, @updated_at, @synced_at)
       ON CONFLICT(uuid) DO UPDATE SET
         name=excluded.name, summary=excluded.summary, model=excluded.model,
         is_starred=excluded.is_starred, project_uuid=excluded.project_uuid,
         updated_at=excluded.updated_at, synced_at=excluded.synced_at`,
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
    });
}

export function upsertMessages(convo: ConversationFull): void {
  const tx = db().transaction((msgs: Message[]) => {
    db().prepare('DELETE FROM messages WHERE conversation_uuid = ?').run(convo.uuid);
    const ins = db().prepare(
      'INSERT INTO messages (uuid, conversation_uuid, idx, sender, text, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    msgs.forEach((m, i) => {
      ins.run(m.uuid, convo.uuid, m.index ?? i, m.sender, messageText(m), m.created_at);
    });
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
}

export function getMessages(convoUuid: string): CachedMessage[] {
  return db()
    .prepare(
      'SELECT uuid, idx, sender, text, created_at FROM messages WHERE conversation_uuid = ? ORDER BY idx ASC',
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

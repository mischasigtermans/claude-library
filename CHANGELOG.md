# Changelog

## [0.3.0] - 2026-07-25

Library stops being a Claude Desktop mirror and becomes an index of everything you have worked through with Claude. Local Claude Code sessions are a second source alongside chats, so one search covers the thinking you did in a chat and the work you did in the terminal. Because Claude Code prunes session transcripts after 30 days, ingesting them is also how you keep them.

**Added**
- Claude Code sessions are indexed alongside Claude Desktop chats. `library_ingest` reads `~/.claude/projects` and keeps your typed prompts, assistant prose and the tool calls that changed something, roughly 1% of the bytes. Tool results, file contents and images are never stored. Sessions land on `platform = 'CLAUDE_CODE'` and group under a project per working directory.
- Redaction pass over everything written to the cache: API keys, JWTs, PEM private key blocks, auth headers, connection-string passwords and secret-shaped assignments. Placeholders and interpolations are left alone, and each run reports how many secrets it caught.
- `source=` on `library_search` narrows message hits to `chat` or `code`. Hits are tagged with their source and, for code, the working directory.
- `SessionStart` and `SessionEnd` hooks keep the index current. Both detach immediately; ingest is an mtime and size watermark sweep against the new `ingest_state` table, so a missed run is picked up by the next one and a routine pass over ~600 sessions takes about two seconds.
- `cwd`, `git_branch` and `source_path` on `conversations`.

**Fixed**
- An org you have left no longer breaks the whole sync. `/api/organizations` keeps listing orgs whose endpoints return 401, and that 401 was read as an expired session, aborting every remaining org and reporting "Claude Desktop session expired" against a perfectly valid cookie. A 401 on a single org is now recorded as `skipped (no API access with this session)` and the run continues. A 401 from `listOrgs`, or every org refusing, still reports an expired session.
- `last_sync_completed_at` is written again. One inaccessible org used to abort `performSync` before it could be set, so the cache looked permanently stale and `library_search` re-synced on every call.
- Bulk message deletes no longer scan the FTS tables once per row. The `messages_ad` and `message_blocks_ad` triggers match on an UNINDEXED column, which made a full refresh quadratic; suppressing them around bulk deletes took it from over ten minutes to under three.

## [0.2.4] - 2026-05-22

**Fixed**
- Sync no longer fails with `403` from Cloudflare. Anthropic tightened the WAF in front of `claude.ai`: every first API request gets challenged, the immediate retry passes. The HTTP layer now retries once on 403.
- User-Agent is now derived at module load from the installed Claude Desktop binary (`Chrome/X Electron/Y Claude/Z`) instead of a hardcoded Chrome 131 string. Falls back to a sane default if Claude.app isn't installed.

## [0.2.3] - 2026-05-20

**Fixed**
- MCP server now reports the correct version. The `Server` constructor was still hardcoded to `0.1.0` and surfaced that to every client on introspection.

**Changed**
- Dropped the stale `jq` / SessionStart hook requirement from the README. No hook ships in the plugin.
- Removed `.claude-plugin/marketplace.json` from the plugin repo. The marketplace catalog lives in `mischasigtermans/by-mischa`; the duplicate here had a stale version and no `source` field.

## [0.2.2] - 2026-05-13

**Fixed**
- Plugin now ships ready to run with no install step. Replaced `better-sqlite3` (native binding, never compiled on install) with Node's built-in `node:sqlite`. Matches the parley and personas plugins: `git clone` → `node dist/server.js` works out of the box.

**Requires**
- Node 22.5+ (for stable `node:sqlite`).

## [0.2.1] - 2026-05-13

**Added**
- `CitationSchema` and `CitationMetadataSchema` cover the citation shape end-to-end. The insert site now narrows from typed values instead of twelve `as` casts.
- `library_status` surfaces the last auto-sync error (timestamp + message), so background failures stop hiding in response prefixes.
- `insertMemorySnapshot` returns whether the row was new. Sync reports count new memory snapshots per org.
- Unknown content block types log a single stderr line per process per type, so Anthropic adding a new block type doesn't vanish silently.

**Changed**
- `library_search` tool description is honest about per-kind semantics. `messages`/`docs`/`memory`/`artifacts` are FTS5; `citations` is LIKE; `tool_calls` is exact match on tool name; `shares` is substring match on snapshot name.
- `compaction_summary` schema is a `string | array | object | null` union instead of `unknown`. Encoded what we observe, not "anything goes".

**Fixed**
- `ToolUseBlock.id`, `ToolUseBlock.name`, and `ToolResultBlock.tool_use_id` are required again. They're the keys that link tool_use to tool_result; nullable join keys were a lie about the data model.
- Artifact extraction runs before the message-write transaction. Regex passes no longer hold the write lock.

## [0.2.0] - 2026-05-13

The buildout and cleanup release. Schema captures the full Claude Desktop library: conversation tree with regen branches, content blocks, citations, tool calls, files, attachments, projects with system prompts, organization memory snapshots, shared conversation links, and assistant-generated artifacts. Then a consolidation pass cut the tool surface from seventeen to seven and pulled type validation to the API edge.

**Added**
- Conversation sync captures the full message tree (`tree=True`), including regen branches via `parent_message_uuid`.
- `message_blocks` table indexes content blocks (text, thinking, tool_use, tool_result) with a separate FTS table (`blocks_fts`).
- `citations` table indexed by domain, with source URL and inline text-position ranges.
- `message_files` table for user-uploaded images per message with visual metadata (primary_color, dimensions).
- `project_files` and per-project `prompt_template` capture from the single-project endpoint.
- `memory_snapshots` table with FTS, inserts on change (deduped on `remote_updated_at`).
- `shares` table records shared conversation snapshots.
- `artifacts` extraction from assistant messages: fenced code blocks ≥ 12 lines or ≥ 400 chars, plus any `<antArtifact>` tags. Indexed with `artifacts_fts`.
- Star-boost in search ranking: starred conversations rank higher; starred projects add a smaller boost.
- Per-target failure samples in the sync report (capped at 5 per org).

**Changed**
- Tool surface consolidated from 17 to 7. Removed: `library_tool_calls`, `library_citations`, `library_shares`, `library_artifacts`, `library_artifact`, `library_memory`, `library_memory_history`, `library_doc`, `library_get`, `library_project`, `library_fetch_files`.
- `library_search` gains `kind` arg (`all` | `messages` | `docs` | `memory` | `artifacts` | `tool_calls` | `citations` | `shares`). The deleted facet tools' behavior is reachable here.
- `library_open <uuid>` dispatcher replaces `library_get`, `library_doc`, `library_artifact`, and `library_memory`. Detects which table owns the UUID and renders accordingly.
- `library_projects` gains optional `name` and `detail` args. `name=X detail=true` returns the full project record including `prompt_template`.
- Validation at the API edge with zod. Each endpoint has a schema; `call<T>` parses instead of casting.
- `Message.content` is a discriminated union (`text` | `thinking` | `tool_use` | `tool_result`). The block-insert path switches on `type` instead of casting twelve fields.
- `ensureColumns(table, [[name, ddl]])` replaces the 25-line backfill ceremony across `conversations`, `messages`, and `projects`.
- `replaceChildren(table, parentCol, parentId, rows, ins)` collapses the seven delete-then-insert sites in the upsert paths.
- `searchArtifacts` (FTS, ranked) split from `listArtifacts` (no rank). No more fake `0 AS rank` in the list path.

**Fixed**
- `listProjectFiles` skipped rows missing `uuid` instead of inventing `Math.random()` primary keys. Same upstream payload now produces the same row count.
- `is_harmony_project`, `docs_count`, and `files_count` default to sane values (0) when the list endpoint omits them.
- `message_files` upsert uses `ON CONFLICT(uuid) DO UPDATE` so the same file appearing in multiple messages doesn't collide.

**Removed**
- `message_attachments` table (write-only, never read).
- `project_prompts_fts` virtual table (no reader).
- `file_blobs` table and `library_fetch_files` tool (write-only, no reader to surface bytes).

## [0.1.0] - 2026-05-13

Initial release after renaming the prior-art prototype `claude-hansard` to `library`. The rename reflects that the cache is a live mirror of your Claude Desktop data, not an archive of inactive material.

- macOS Keychain + Chromium cookie decryption for `claude.ai` sessions.
- SQLite + FTS5 cache at `~/.claude/library/library.db`.
- Tools: `library_sync`, `library_list`, `library_search`, `library_outline`, `library_get`, `library_doc`, `library_projects`, `library_status`.
- Incremental conversation sync. Paginates the full list, fetches message bodies only for new or updated conversations.
- Project knowledge-base document indexing with a separate FTS table.
- Freshness gate: `library_search` and `library_list` auto-sync if the cache is older than 24 hours.
- Clear "session expired" error when the Desktop cookie returns 401.

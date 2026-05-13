# Changelog

## [0.2.1] - 2026-05-13

Type-safety follow-ups from the post-0.2.0 cross-review and a couple of observability fixes.

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

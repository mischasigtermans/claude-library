# Changelog

## 0.4.0 — Round 2: tool surface consolidation (breaking)

Tool count reduced from 17 to 6. All deleted tools' behavior is preserved through the surviving surface.

**Removed tools:** `library_tool_calls`, `library_citations`, `library_shares`, `library_artifacts`, `library_artifact`, `library_memory`, `library_memory_history`, `library_doc`, `library_get`, `library_project`.

**New and changed:**

- `library_search` gains `kind` arg (`all` | `messages` | `docs` | `memory` | `artifacts` | `tool_calls` | `citations` | `shares`). Default `all` keeps existing behavior. Each non-`all` kind routes to the matching source. `kind=memory` with no query lists snapshot history (replaces `library_memory_history`).
- `library_open <uuid>` — new dispatcher. Probes conversations, project_docs, artifacts, shares, and memory_snapshots in order and returns the matching item. Optional `from`/`to` apply when the target is a conversation. Replaces `library_get`, `library_doc`, `library_artifact`, and `library_memory`.
- `library_projects` gains optional `name` and `detail` args. `name=X detail=true` returns the full project record including `prompt_template`. Replaces `library_project`.

## 0.1.0

Initial release of Claude Library.

- macOS Keychain + Chromium cookie decryption for `claude.ai` sessions.
- SQLite + FTS5 cache at `~/.claude/library/library.db`.
- Tools: `library_sync`, `library_list`, `library_search`, `library_outline`, `library_get`, `library_doc`, `library_projects`, `library_status`.
- Incremental conversation sync. Paginates full list, fetches message bodies only for new/updated conversations.
- Project knowledge-base document indexing with separate FTS table.
- Freshness gate: `library_search` and `library_list` auto-sync if cache is older than 24 hours.
- Clear "session expired" error when Desktop cookie returns 401.
- Forked from prior-art prototype `claude-hansard` (rename to `library` reflects that the cache mirrors live data, not an archive).

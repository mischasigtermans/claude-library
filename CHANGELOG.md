# Changelog

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

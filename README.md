# Library

Read your Claude Desktop conversations from any Claude Code session.

`/library` ships a small MCP server. It decrypts your Claude Desktop session cookies via the macOS Keychain, pulls conversations from `claude.ai`, caches them locally in SQLite, and exposes tools to search, outline, and read them.

## Tools

- `library_sync`. Pull new and updated conversations and project knowledge-base docs. Incremental by default.
- `library_list`. Recent conversations from the cache. Filter by project.
- `library_search`. Full-text search (SQLite FTS5) across messages and project docs.
- `library_projects`. Projects with conversation counts.
- `library_outline`. Turn-by-turn summary of one conversation.
- `library_get`. Full transcript, optionally bounded by turn range.
- `library_doc`. Full text of one project knowledge-base document.
- `library_status`. Cache state and auth check.

## Why

Claude Desktop conversations live on Anthropic's servers. Claude Code can't see them. Library bridges that gap so a Code session can recall what you worked through with Desktop without copy-paste.

It's not Parley. Parley routes live messages between running peer agents. Library is read-only access to frozen transcripts.

## Install

```bash
git clone https://github.com/mischasigtermans/claude-library
cd claude-library
bun install
bun run build
```

Register with Claude Code:

```
/plugin marketplace add /path/to/claude-library
/plugin install library@library
/reload-plugins
```

First run:

```
/library sync
```

## How it works

1. Reads the AES key from macOS Keychain (`Claude Safe Storage`, account `Claude Key`).
2. Decrypts the `sessionKey` and `cf_clearance` cookies from Claude Desktop's cookie store.
3. Calls `https://claude.ai/api/organizations/{org}/chat_conversations` with those cookies.
4. Stores conversation metadata and message bodies in `~/.claude/library/library.db`.
5. Indexes messages in an FTS5 virtual table for fast search.

Sync is incremental. It paginates the full conversation list on every run, but only re-fetches message bodies for conversations whose `updated_at` changed. Use `--full` to force a complete refetch.

`library_search` and `library_list` auto-sync if the cache is older than 24 hours. Pass `noSync: true` to skip the freshness check.

## Caveats

- macOS only. Uses the `security` CLI and Chromium-format cookie store. Linux and Windows need a different cookie path.
- Touches your real Claude session. Treat the cache as sensitive.
- SSO-only orgs return 403 with personal session cookies. Library skips them gracefully.
- When the session cookie expires, library surfaces a clear "session expired" error. Open Claude Desktop and sign in to refresh the cookie, then retry.

## License

MIT

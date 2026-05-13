# Claude Library

Local searchable mirror of your Claude Chats.

Claude Chats are your conversations with Claude on claude.ai, in the Desktop app, or on mobile. Not Claude Code. Not Cowork. The chat product. Those conversations live on Anthropic's servers, so Code sessions can't see them. Claude Library uses your Claude Desktop session cookie to pull your chats, projects, memory, and shared snapshots, and caches them locally in SQLite. Any Claude Code or Cowork session can then search and read what you worked through.

## Installation

```
/plugin marketplace add mischasigtermans/by-mischa
/plugin install library@by-mischa
```

### Requires

- macOS (uses the `security` CLI and Chromium-format cookie store)
- Claude Desktop, signed in
- `jq` for the SessionStart hook (`brew install jq`)

## Quick start

```
/library sync
/library search "stripe webhook retries"
```

First sync pulls every conversation, project, doc, memory snapshot, and share into `~/.claude/library/library.db`. After that, sync is incremental. Search hits return ranked snippets across messages, project knowledge-base docs, your memory text, and extracted code artifacts. Drill into any result with `/library open <uuid>`.

## Features

- Full-text search (FTS5) across conversation messages, project knowledge-base docs, memory snapshots, and assistant-generated code artifacts.
- Filtered search per source via `kind=`: messages, docs, memory, artifacts, tool_calls, citations, shares.
- Branch-aware sync: captures regen branches via the conversation tree, not just the active leaf.
- Project view with `prompt_template` (system prompt) per project plus knowledge-base docs and files.
- Versioned memory snapshots, inserted on change so the history is preserved.
- Lazy thumbnail fetch for uploaded images per message.
- Star-boosted ranking: starred conversations and starred projects rank higher in search.
- Read-only against the live API. No writes back to claude.ai.

## How it works

Reads the AES key from the macOS Keychain (`Claude Safe Storage`), decrypts the `sessionKey` and `cf_clearance` cookies from Claude Desktop's cookie store, and calls `claude.ai/api/organizations/...` with those cookies. Responses are validated at the edge with zod and written to the local SQLite cache. Search functions hit FTS5 virtual tables; `kind=tool_calls`, `kind=citations`, and `kind=shares` use direct table queries (see `library_search` description for per-kind semantics).

Sync is incremental. Paginates the conversation list every run, fetches message bodies only for conversations whose `updated_at` advanced. Pass `full=true` to force a complete refetch. `library_search` and `library_list` auto-sync if the cache is older than 24 hours.

## Caveats

- SSO-only orgs return 403 with personal session cookies. Library skips them gracefully.
- When the session cookie expires, library surfaces a clear "session expired" error. Open Claude Desktop and sign in to refresh, then retry.
- Treat the cache as sensitive. It contains your full Claude Desktop history including memory and project system prompts.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Credits

- [Mischa Sigtermans](https://github.com/mischasigtermans)

## License

MIT. See [LICENSE](LICENSE).

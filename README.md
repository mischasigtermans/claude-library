# Claude Library

[![Version](https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/mischasigtermans/claude-library/main/.claude-plugin/plugin.json&query=$.version&label=version&prefix=v)](https://github.com/mischasigtermans/claude-library)
[![License](https://img.shields.io/github/license/mischasigtermans/claude-library)](LICENSE)

Local searchable mirror of everything you have worked through with Claude, readable from any Claude Code session.

Two sources feed one index. **Chats** are your conversations on claude.ai, in the Desktop app, or on mobile; they live on Anthropic's servers, so Library pulls them with your Claude Desktop session cookie. **Code sessions** are the transcripts Claude Code writes to `~/.claude/projects`; Library reads them off disk. Both land in the same SQLite database, so one search covers the thinking you did in chat and the work you did in the terminal.

Code sessions are pruned after 30 days by default. Ingesting them is also how you keep them.

## Installation

```
/plugin marketplace add mischasigtermans/by-mischa
/plugin install library@by-mischa
```

### Requires

- macOS (uses the `security` CLI and Chromium-format cookie store)
- Claude Desktop, signed in, for chats. Code sessions need neither.
- Node 22.5+ (for the built-in `node:sqlite` module)

## Quick start

```
/library sync
/library search "stripe webhook retries"
```

First sync pulls every conversation, project, doc, memory snapshot, and share into `~/.claude/library/library.db`. After that, sync is incremental. Search hits return ranked snippets across messages, project knowledge-base docs, your memory text, and extracted code artifacts. Drill into any result with `/library open <uuid>`.

Claude Code sessions ingest automatically at the start and end of every session; `/library ingest` pulls them in on demand. Hits are tagged `[code/…]` or `[chat/…]`, and `source=code` or `source=chat` narrows a search to one of them.

## Features

- Full-text search (FTS5) across conversation messages, project knowledge-base docs, memory snapshots, and assistant-generated code artifacts.
- Local Claude Code sessions indexed alongside chats, grouped by working directory, filterable with `source=`.
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

### Claude Code ingest

Session transcripts in `~/.claude/projects` are JSONL, and roughly 99% of their bytes are tool results: file contents, command output, diffs. Library keeps the other 1%.

Stored: your typed prompts (identified by `origin.kind`, not guessed from shape), assistant prose, and the name and arguments of tools that changed something (`Bash`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`). Tool calls fold into the assistant message that preceded them.

Never stored: tool results, file contents, images, read-only tool calls, and the `subagents/`, `tool-results/` and `memory/` subdirectories.

Everything that is stored passes through a redaction pass first. It removes API keys (Anthropic, OpenAI, Stripe, GitHub, Slack, AWS, Google), JWTs, PEM private key blocks, bearer and basic auth headers, passwords inside connection strings, and secret-shaped or high-entropy assignments, while leaving placeholders like `${VAR}` and `changeme` intact. Ingest reports how many it caught.

Ingest is incremental against an `ingest_state` watermark of mtime and size per file, so unchanged sessions are skipped. A full pass over ~600 sessions takes about three minutes; a routine pass takes about two seconds. The `SessionEnd` hook is the fast path and `SessionStart` is the net that catches crashes, `kill -9`, closed terminals and restarts, where `SessionEnd` never fires. Both are detached and never block a session. Pass `full=true` to rebuild from scratch.

## Caveats

- `/api/organizations` lists orgs you have no API access to, including ones you have left. Their endpoints return 401. Library records them as skipped and syncs the rest.
- A session expired error means the cookie is genuinely dead: it is raised when the org listing itself is refused, or when every org is. Open Claude Desktop and sign in to refresh, then retry.
- Treat the cache as sensitive. It contains your full Claude Desktop history including memory and project system prompts, plus every prompt you have typed into Claude Code.
- Redaction catches known secret formats, not meaning. A client name, a deal figure or an unreleased plan is stored as written.
- Resuming a session copies earlier turns into the new transcript, so text shared by a session and its resume appears once per session.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Credits

- [Mischa Sigtermans](https://mischa.sigtermans.me)

## License

MIT. See [LICENSE](LICENSE).

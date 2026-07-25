---
name: library
description: Read the user's past work with Claude from this Claude Code session, both Claude Desktop chats and earlier Claude Code sessions. Activates when the user references past chats or past terminal work, asks "what did I tell Claude about X", "find that conversation where I", "when did I last touch Y", "what did we decide about Z", or invokes /library. Routes through the library MCP server.
---

# Library

A read-only window into everything the user has worked through with Claude. Two sources, one index:

- **Chats** from claude.ai, Desktop and mobile, pulled through Claude's session cookies.
- **Claude Code sessions** read from `~/.claude/projects`, grouped by working directory.

State lives in `~/.claude/library/library.db`. Use the `library_*` tools for every operation. **Never** read or write the cache file directly.

## When this skill activates

Two paths.

1. **Awareness path.** The user references their own Claude history in natural language. Examples:
   - "what did I tell Claude about that bug?"
   - "find the chat where I designed the schema"
   - "pull up my conversation about pricing"
   - "didn't I work through this with Claude already?"

   Take the *find sequence* below.

2. **Explicit path.** The user typed `/library` or `/library <action>`. Jump to *Actions*.

Don't fire for things obviously about the *current* session, which you can already see.

## Find sequence

Default loop when the user wants to recall something from past chats.

1. **Search first.** Call `library_search` with a tight query. 2-4 keywords, FTS5 syntax. Don't dump the whole user query in.
2. **Read the snippets.** Pick the most relevant 1-3 hits. Hits come in sections: `[chat/human]`, `[chat/assistant]`, `[code/human]` and `[code/assistant]` from messages, `[doc]` from project knowledge-base files, `[memory #N]` from memory snapshots, `[artifact]` from code blocks. Code hits also show their working directory.
3. **Drill in.** For any hit with a UUID, call `library_open <uuid>` to read the full item. For conversations, call `library_outline` first, then `library_open` with `from`/`to` bounds.
4. **Pull only what's needed.** Don't fetch the full transcript when 5 messages will do.
5. **Answer the user.** Quote the relevant passage. Cite the conversation title or doc filename, plus date.

If `library_search` returns nothing, call `library_list` to see what's cached. The user may need to sync.

### Choosing a source

`source=` narrows message hits. Default is both, which is usually right.

- `source=chat` when the user is recalling thinking: decisions, strategy, drafting, anything they talked through rather than built.
- `source=code` when the user is recalling work: when a file changed, which command they ran, what broke in a repo.

Code sessions hold what the user typed and what Claude replied. They never hold file contents or command output, so don't expect to recover a diff or a stack trace from them. Read the repo for that.

### Language-aware querying

FTS5 doesn't stem, translate, or fuzzy-match. The cached corpus may be in a different language than the question, or mixed.

Check `library_list` titles first to spot the corpus language.

- Titles consistently in one language: search in that language.
- Mixed: search both variants with `OR` and merge.

If the question and the titles are in different languages, translate the salient nouns into the corpus language before searching. People ask in their working language. The conversation was written in whatever they used at the time.

Hit rate goes up when you:

- Strip stopwords. `"the broken build"` becomes `broken`.
- Drop quotes on multi-word phrases. Quotes force exact adjacency and miss often.
- Pick the distinctive noun. Names, jargon, and proper nouns beat verbs and adjectives.
- OR the noun across two languages when in doubt.

When a title looks right but search misses, fall back to `library_list` for browsing or `library_outline` on the suspected UUID.

## Actions

### `(no argument)` or `status`

Call `library_status`. Print the result. If `cached conversations: 0`, suggest `/library sync`.

### `sync [--full] [--org NAME]`

Call `library_sync`. Set `full: true` if `--full` is present. Pass `org` if given. Print the result.

Sync is incremental by default. It pulls conversation metadata for every page and only fetches message bodies for new or updated conversations. `--full` re-fetches everything.

### `ingest [--full]`

Call `library_ingest`. Set `full: true` if `--full` is present. Print the result.

Pulls Claude Code sessions from `~/.claude/projects`. This runs on its own at the start and end of every session, so reach for it only when the user wants the index current right now, or when `--full` is needed to rebuild after a parser change.

### `list [N] [--project NAME]`

Call `library_list` with `limit` and optional `project`. Default limit 25. Print the table.

### `search <query> [--kind KIND] [--source SOURCE]`

Call `library_search` with the query. Optionally pass `source` (`all`, `chat`, `code`) to restrict message hits to one origin, and `kind` to restrict to one backend:

- `all` (default): messages, docs, memory, artifacts
- `messages`: conversation message bodies only
- `docs`: project knowledge-base documents only
- `memory`: organization memory snapshots (no query = list all snapshots)
- `artifacts`: extracted code blocks and antArtifact tags
- `tool_calls`: tool invocations (query matches tool name)
- `citations`: web citations (query matches title, URL, site name)
- `shares`: shared conversation snapshots

### `projects [--name NAME] [--detail]`

Call `library_projects`. With no args, lists all projects with conversation counts. With `name=X`, filters to one project. With `name=X detail=true`, returns the full record including system prompt.

### `outline <uuid>`

Call `library_outline`. Print the outline.

### `open <uuid> [from] [to]`

Call `library_open`. Detects what kind of item the UUID belongs to (conversation, doc, artifact, share, or memory snapshot) and returns the appropriate content. For conversations, `from`/`to` bound the message range.

### Unknown action

Print:
```
Common moves:
  library sync                   pull new and updated conversations
  library list                   show cached conversations
  library search <query>         full-text search across messages, docs, memory, artifacts
  library search <query> kind=X  restrict to one source (messages/docs/memory/artifacts/tool_calls/citations/shares)
  library projects               list projects with conversation counts
  library projects name=X detail=true  full project record including system prompt
  library outline <uuid>         turn-by-turn outline of one conversation
  library open <uuid>            read any item by uuid (conversation, doc, artifact, share, memory)
  library status                 cache and auth check
```

## Don'ts

- Don't `library_open` an entire 200-message conversation when the user asked one question. Use `library_outline` plus a bounded `library_open`.
- Don't ask the user to sync without first checking `library_status` to see if the cache is empty.
- Don't fabricate conversation titles or UUIDs. If a search returns nothing, say so.
- Don't read `~/.claude/library/library.db` with Bash. Use the tools.
- Don't fire on questions about the current session's history.

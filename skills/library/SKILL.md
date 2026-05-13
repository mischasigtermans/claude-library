---
name: library
description: Read the user's Claude Desktop conversations from this Claude Code session. Activates when the user references past chats with Claude (Desktop or web), asks "what did I tell Claude about X", "find that conversation where I", "pull the chat about Y", or invokes /library. Routes through the library MCP server.
---

# Library

A read-only window into the user's Claude Desktop conversation history. Each chat lives on Anthropic's servers. The `library` MCP server pulls them through Claude's session cookies and caches them locally for fast outline and full-text search.

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

Don't fire for things obviously about the *current* Claude Code session. Don't fire for Claude Code session history (that's a different MCP).

## Find sequence

Default loop when the user wants to recall something from past chats.

1. **Search first.** Call `library_search` with a tight query. 2-4 keywords, FTS5 syntax. Don't dump the whole user query in.
2. **Read the snippets.** Pick the most relevant 1-3 hits. Hits come in two flavours: `[human]/[assistant]` from chat messages, `[doc]` from project knowledge-base files.
3. **Drill in:**
   - For a chat hit, call `library_outline` on the conversation UUID, then `library_get` with bounds around the relevant turns.
   - For a doc hit, call `library_doc` on the doc UUID for the full file.
4. **Pull only what's needed.** Don't fetch the full transcript when 5 messages will do. Don't dump a whole doc when the snippet already answers.
5. **Answer the user.** Quote the relevant passage. Cite the conversation title or doc filename, plus date.

If `library_search` returns nothing, call `library_list` to see what's cached. The user may need to sync.

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

### `list [N] [--project NAME]`

Call `library_list` with `limit` and optional `project`. Default limit 25. Print the table.

### `search <query>`

Call `library_search` with the query. Print hits.

### `projects`

Call `library_projects`. Print the list with conversation counts.

### `outline <uuid>`

Call `library_outline`. Print the outline.

### `get <uuid> [from] [to]`

Call `library_get` with the bounds. Print the transcript.

### `doc <uuid>`

Call `library_doc`. Print the full document body. Use this for `[doc]` hits returned by `library_search`.

### Unknown action

Print:
```
Common moves:
  library sync                   pull new and updated conversations
  library list                   show cached conversations
  library search <query>         full-text search across messages and project docs
  library projects               list projects with conversation counts
  library outline <uuid>         turn-by-turn outline of one conversation
  library get <uuid>             full transcript
  library doc <uuid>             full project knowledge-base document
  library status                 cache and auth check
```

## Don'ts

- Don't `library_get` an entire 200-message conversation when the user asked one question. Use `outline` plus a bounded `get`.
- Don't ask the user to sync without first checking `library_status` to see if the cache is empty.
- Don't fabricate conversation titles or UUIDs. If a search returns nothing, say so.
- Don't read `~/.claude/library/library.db` with Bash. Use the tools.
- Don't fire on questions about the current session's history.

import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  replaceProjectDocs,
  upsertCodeSession,
  upsertConversation,
  upsertMessages,
  upsertProject,
} from '../src/lib/cache.js';
import type { CodeSession } from '../src/lib/code.js';
import { tools } from '../src/tools/index.js';

const APP = '~/Sites/app';
const LONG = '~/Github/mischasigtermans/claude-library';
const NO_PROJECT = 'No project matches "nope". Try library_projects to list them.';

// Every seeded message holds "invoicing" plus one marker word, so a test names the hits it expects.
const MARKERS = ['oldprompt', 'oldreply', 'midnightprompt', 'newreply', 'otherprompt', 'chatprompt', 'chatreply'];
const found = (out: string): string[] => MARKERS.filter((m) => out.includes(m));
const hitLine = (out: string, marker: string): string => {
  const lines = out.split('\n');
  return lines[lines.findIndex((l) => l.includes(marker)) - 1];
};

const tool = (name: string) => tools.find((t) => t.name === name)!;
// noSync goes last: without it the handler pulls real chats from claude.ai.
const search = (args: Record<string, unknown> = {}): Promise<string> =>
  tool('library_search').handler({ query: 'invoicing', kind: 'messages', ...args, noSync: true });

type Turn = [sender: 'human' | 'assistant', createdAt: string, text: string];

function codeSession(id: string, name: string, project: string, turns: Turn[]): CodeSession {
  const cwd = project.replace('~', homedir());
  return {
    uuid: `code:${id}`,
    sessionId: id,
    projectDir: cwd.replace(/\//g, '-'),
    name,
    cwd,
    gitBranch: 'main',
    version: '2.1.214',
    createdAt: turns[0][1],
    updatedAt: turns[turns.length - 1][1],
    messages: turns.map(([sender, createdAt, text], idx) => ({
      uuid: `code:${id}:m${idx}`,
      idx,
      sender,
      text,
      createdAt,
      parentUuid: null,
      inputMode: null,
      blocks: [{ position: 0, type: 'text', text, toolUseId: null, toolName: null, toolInputJson: null }],
    })),
    redactions: 0,
  };
}

beforeAll(() => {
  const path = process.env.LIBRARY_DB ?? '';
  if (!path.startsWith(tmpdir())) throw new Error(`Refusing to seed: LIBRARY_DB is "${path}", not a temp path.`);

  upsertCodeSession(
    codeSession('sess-app', 'Invoice rounding', APP, [
      ['human', '2026-10-20T09:00:00.000Z', 'oldprompt invoicing rounding is off'],
      ['assistant', '2026-10-20T09:00:05.000Z', 'oldreply invoicing rounds half up'],
      ['human', '2026-11-02T00:00:00.000Z', 'midnightprompt invoicing at the boundary'],
      ['assistant', '2026-11-10T14:00:00.000Z', 'newreply invoicing fix shipped'],
    ]),
    { path: '/sessions/sess-app.jsonl', mtimeMs: 1, size: 1 },
  );
  upsertCodeSession(
    codeSession('sess-library', 'Export script', LONG, [
      ['human', '2026-10-21T10:00:00.000Z', 'otherprompt invoicing export in another repo'],
    ]),
    { path: '/sessions/sess-library.jsonl', mtimeMs: 1, size: 1 },
  );

  // Another fraction and offset than the code sessions above: `before` has to compare instants.
  upsertProject('org-1', { uuid: 'proj-finance', name: 'Finance', created_at: '2026-09-01T00:00:00.000000+00:00' });
  const chat = {
    uuid: 'conv-finance',
    name: 'Payment terms',
    project_uuid: 'proj-finance',
    created_at: '2026-11-01T23:59:59.123456+00:00',
    updated_at: '2026-11-03T08:00:00.654321+00:00',
    chat_messages: [
      {
        uuid: 'chat-m0',
        sender: 'human' as const,
        text: 'chatprompt invoicing terms for the client',
        created_at: '2026-11-01T23:59:59.123456+00:00',
        updated_at: '2026-11-01T23:59:59.123456+00:00',
      },
      {
        uuid: 'chat-m1',
        sender: 'assistant' as const,
        text: 'chatreply invoicing net thirty',
        created_at: '2026-11-03T08:00:00.654321+00:00',
        updated_at: '2026-11-03T08:00:00.654321+00:00',
      },
    ],
  };
  upsertConversation('org-1', chat);
  upsertMessages(chat);
  replaceProjectDocs('proj-finance', [
    {
      uuid: 'doc-terms',
      project_uuid: 'proj-finance',
      file_name: 'terms.md',
      content: 'docmarker invoicing policy',
      created_at: '2026-09-01T00:00:00.000000+00:00',
    },
  ]);
});

describe('library_search message filters', () => {
  it('seeds the temp database, not the live index', async () => {
    expect(existsSync(process.env.LIBRARY_DB!)).toBe(true);
    expect(found(await search())).toEqual(MARKERS);
  });

  describe('project', () => {
    it('narrows to a Claude Code working directory by name', async () => {
      expect(found(await search({ project: APP }))).toEqual(['oldprompt', 'oldreply', 'midnightprompt', 'newreply']);
    });

    it('narrows to a Claude Desktop project by name or UUID', async () => {
      expect(found(await search({ project: 'finance' }))).toEqual(['chatprompt', 'chatreply']);
      expect(found(await search({ project: 'proj-finance' }))).toEqual(['chatprompt', 'chatreply']);
    });

    it('takes the working directory a hit prints, however long', async () => {
      expect(hitLine(await search(), 'otherprompt')).toContain(`  ${LONG}  `);
      expect(found(await search({ project: LONG }))).toEqual(['otherprompt']);
    });

    it('answers an unknown project the way library_list does', async () => {
      expect(await tool('library_list').handler({ project: 'nope', noSync: true })).toBe(NO_PROJECT);
      expect(await search({ project: 'nope' })).toBe(NO_PROJECT);
      expect(await search({ project: 'nope', kind: 'all' })).toBe(NO_PROJECT);
    });
  });

  describe('before', () => {
    it('reads a bare date as the start of that day', async () => {
      expect(found(await search({ before: '2026-11-02' }))).toEqual(['oldprompt', 'oldreply', 'otherprompt', 'chatprompt']);
    });

    it('honours an offset on a datetime', async () => {
      expect(found(await search({ before: '2026-10-20T11:00:03+02:00' }))).toEqual(['oldprompt']);
    });

    it('reads a datetime without an offset as UTC', async () => {
      expect(found(await search({ before: '2026-10-20T09:00:03' }))).toEqual(['oldprompt']);
      expect(found(await search({ before: '2026-10-20 09:00:03' }))).toEqual(['oldprompt']);
    });

    it.each(['last tuesday', '2026-02-30', '02-11-2026', ''])('rejects "%s" and names the accepted form', async (before) => {
      await expect(search({ before })).rejects.toThrow(
        'before must be an ISO date or datetime, such as 2026-11-02 or 2026-11-02T09:30:00Z',
      );
    });
  });

  describe('sender', () => {
    it('narrows to the prompts the user typed', async () => {
      expect(found(await search({ sender: 'human' }))).toEqual(['oldprompt', 'midnightprompt', 'otherprompt', 'chatprompt']);
    });

    it('narrows to the assistant replies', async () => {
      expect(found(await search({ sender: 'assistant' }))).toEqual(['oldreply', 'newreply', 'chatreply']);
    });

    it('keeps both with "all"', async () => {
      expect(found(await search({ sender: 'all' }))).toEqual(MARKERS);
    });

    it('rejects an unknown sender and names the accepted values', async () => {
      await expect(search({ sender: 'user' })).rejects.toThrow('sender must be "all", "human" or "assistant"');
    });
  });

  it('combines project, before and sender with source=code', async () => {
    const out = await search({ project: APP, before: '2026-11-02', sender: 'human', source: 'code' });
    expect(found(out)).toEqual(['oldprompt']);
  });

  it('finds nothing when the filters exclude each other', async () => {
    expect(await search({ project: APP, source: 'chat' })).toBe('No message matches for "invoicing".');
  });

  it('prints the day of the message after the title', async () => {
    const out = await search();
    expect(hitLine(out, 'oldprompt')).toBe(`[code/human] Invoice rounding  2026-10-20  ${APP}  (code:sess-app)`);
    expect(hitLine(out, 'newreply')).toBe(`[code/assistant] Invoice rounding  2026-11-10  ${APP}  (code:sess-app)`);
    expect(hitLine(out, 'chatprompt')).toBe('[chat/human] Payment terms  2026-11-01  (conv-finance)');
  });

  it('narrows only the message part of kind=all', async () => {
    const out = await search({ kind: 'all', project: APP, sender: 'human', before: '2026-11-02' });
    expect(found(out)).toEqual(['oldprompt']);
    expect(out).toContain('Project docs (1):');
    expect(out).toContain('docmarker');
  });
});

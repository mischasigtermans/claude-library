import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// No test may open the live index at ~/.claude/library/library.db.
const dir = mkdtempSync(join(tmpdir(), 'library-test-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

export default defineConfig({
  test: { env: { LIBRARY_DB: join(dir, 'library.db') } },
});

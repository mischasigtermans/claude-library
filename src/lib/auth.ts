import { execFileSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const COOKIE_DB = join(homedir(), 'Library', 'Application Support', 'Claude', 'Cookies');
const KEYCHAIN_SERVICE = 'Claude Safe Storage';
const KEYCHAIN_ACCOUNT = 'Claude Key';

let cachedAesKey: Buffer | null = null;

function getAesKey(): Buffer {
  if (cachedAesKey) return cachedAesKey;
  const raw = execFileSync(
    'security',
    ['find-generic-password', '-wa', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE],
    { encoding: 'utf8' },
  ).trim();
  cachedAesKey = pbkdf2Sync(raw, 'saltysalt', 1003, 16, 'sha1');
  return cachedAesKey;
}

function decrypt(encrypted: Buffer): string {
  const key = getAesKey();
  const iv = Buffer.alloc(16, 0x20);
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  const pt = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  // Strip 32-byte SHA prefix Chromium prepends in v10+ on macOS.
  const stripped = pt.subarray(32);
  const pad = stripped[stripped.length - 1];
  if (pad < 1 || pad > 16) {
    throw new Error('library: cookie decryption failed (invalid padding)');
  }
  return stripped.subarray(0, stripped.length - pad).toString('utf8');
}

export interface ClaudeCookies {
  sessionKey: string;
  cfClearance?: string;
}

export function readClaudeCookies(): ClaudeCookies {
  if (!existsSync(COOKIE_DB)) {
    throw new Error(`library: Claude Desktop cookie database not found at ${COOKIE_DB}`);
  }
  const db = new DatabaseSync(COOKIE_DB, { readOnly: true });
  try {
    const get = (name: string): string | undefined => {
      const row = db
        .prepare(
          "SELECT encrypted_value FROM cookies WHERE name = ? AND host_key = '.claude.ai' ORDER BY length(encrypted_value) DESC LIMIT 1",
        )
        .get(name) as { encrypted_value: Uint8Array } | undefined;
      if (!row) return undefined;
      try {
        return decrypt(Buffer.from(row.encrypted_value));
      } catch {
        return undefined;
      }
    };
    const sessionKey = get('sessionKey');
    if (!sessionKey) {
      throw new Error(
        'library: no sessionKey cookie found. Open Claude Desktop and sign in, then retry.',
      );
    }
    return { sessionKey, cfClearance: get('cf_clearance') };
  } finally {
    db.close();
  }
}

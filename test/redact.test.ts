import { describe, expect, it } from 'vitest';
import { redact } from '../src/lib/redact.js';

// These fixtures are invented, but they have to match real credential formats or they
// would not exercise the patterns. Assembling them at runtime keeps any contiguous
// credential-shaped literal out of the source, so secret scanners read the file as clean.
const fake = (...parts: string[]): string => parts.join('');

describe('redact', () => {
  const secrets: Array<[string, string]> = [
    ['anthropic', fake('sk-', 'ant-', 'api03-', 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH')],
    ['openai', fake('sk-', 'proj-', 'AAAABBBBCCCCDDDDEEEEFFFFGGGG')],
    ['stripe live', fake('sk', '_live_', '51AbCdEfGhIjKlMnOpQrStUv')],
    ['stripe restricted', fake('rk', '_live_', '51AbCdEfGhIjKlMnOpQrStUv')],
    ['github classic', fake('ghp', '_', 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII')],
    ['github fine-grained', fake('github', '_pat_', '11AAAAAAA0BBBBBBBBBBCCCCCCCCCC')],
    ['slack', fake('xoxb', '-123456789012-', '1234567890123-', 'AbCdEfGhIjKlMnOpQrStUvWx')],
    ['aws key id', fake('AKIA', 'IOSFODNN7EXAMPLE')],
    ['google', fake('AIza', 'SyD4x9Kk2mNpQrStUvWxYz0123456789abc')],
    ['jwt', fake('eyJhbGciOiJIUzI1NiJ9.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')],
  ];

  for (const [label, secret] of secrets) {
    it(`removes ${label} tokens`, () => {
      const { text, count } = redact(`here is the key ${secret} use it`);
      expect(text).not.toContain(secret);
      expect(text).toContain('[REDACTED');
      expect(count).toBeGreaterThan(0);
    });
  }

  it('removes PEM private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\nabcd\n-----END RSA PRIVATE KEY-----';
    const { text } = redact(`key:\n${pem}\ndone`);
    expect(text).not.toContain('MIIEowIBAAKCAQEA1234');
    expect(text).toContain('[REDACTED:private-key]');
    expect(text).toContain('done');
  });

  it('removes passwords from connection strings', () => {
    const { text } = redact('DATABASE_URL=postgres://admin:hunter2seventeen@db.host:5432/app');
    expect(text).not.toContain('hunter2seventeen');
  });

  it('removes bearer tokens', () => {
    const { text } = redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    expect(text).toContain('Bearer [REDACTED:token]');
  });

  it('redacts secret-shaped assignments while keeping the key name', () => {
    const { text } = redact('STRIPE_SECRET_KEY=abcd1234efgh5678');
    expect(text).toContain('STRIPE_SECRET_KEY=');
    expect(text).not.toContain('abcd1234efgh5678');
  });

  it('redacts high-entropy env values without a secret-shaped name', () => {
    const { text } = redact('APP_KEY=base64Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5');
    expect(text).not.toContain('base64Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5');
  });

  it('leaves placeholders and interpolations alone', () => {
    const samples = ['API_KEY=${OPENAI_KEY}', 'PASSWORD=changeme', 'SECRET=xxxxxxxxxxxx', 'TOKEN=<your-token>'];
    for (const s of samples) {
      const { count } = redact(s);
      expect(count, s).toBe(0);
    }
  });

  it('leaves ordinary prose and code untouched', () => {
    const prose = 'We shipped the invoicing flow. See src/lib/cache.ts:120 and the Stagent contract.';
    expect(redact(prose)).toEqual({ text: prose, count: 0 });
  });

  it('is idempotent', () => {
    const once = redact(`key ${fake('sk-', 'ant-', 'api03-', 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH')} here`).text;
    expect(redact(once).text).toBe(once);
  });

  it('handles empty input', () => {
    expect(redact('')).toEqual({ text: '', count: 0 });
  });
});

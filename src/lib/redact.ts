const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED:anthropic-key]'],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, '[REDACTED:stripe-key]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED:openai-key]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g, '[REDACTED:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED:github-token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key-id]'],
  [/\bAIza[A-Za-z0-9_-]{35}\b/g, '[REDACTED:google-key]'],
  [/\bey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED:jwt]'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@/gi, '[REDACTED:credentialed-url]@'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g, 'Bearer [REDACTED:token]'],
  [/\b(?:Basic)\s+[A-Za-z0-9+/]{20,}={0,2}/g, 'Basic [REDACTED:token]'],
];

const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET|DSN|CREDENTIALS?)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)([^\s"',;]{8,})\3/gi;

const HIGH_ENTROPY_ENV = /^([A-Z][A-Z0-9_]{2,})=(["']?)([A-Za-z0-9+/_-]{24,}={0,2})\2$/gm;

export interface RedactionResult {
  text: string;
  count: number;
}

export function redact(input: string): RedactionResult {
  if (!input) return { text: input, count: 0 };
  let count = 0;
  let text = input;

  for (const [re, replacement] of PATTERNS) {
    text = text.replace(re, () => {
      count++;
      return replacement;
    });
  }

  text = text.replace(SECRET_ASSIGNMENT, (_m, name, sep, quote, value) => {
    if (isPlaceholder(value)) return `${name}${sep}${quote}${value}${quote}`;
    count++;
    return `${name}${sep}${quote}[REDACTED]${quote}`;
  });

  text = text.replace(HIGH_ENTROPY_ENV, (_m, name, quote, value) => {
    if (isPlaceholder(value)) return `${name}=${quote}${value}${quote}`;
    count++;
    return `${name}=${quote}[REDACTED]${quote}`;
  });

  return { text, count };
}

function isPlaceholder(value: string): boolean {
  const v = value.toLowerCase();
  if (v.startsWith('[redacted')) return true;
  if (v.startsWith('${') || v.startsWith('$(') || v.startsWith('%(')) return true;
  if (/^(null|nil|true|false|none|undefined|changeme|password|secret|xxx+|\.{3,}|<[^>]+>)$/.test(v)) return true;
  if (/^[x*.\-_]+$/.test(v)) return true;
  return false;
}

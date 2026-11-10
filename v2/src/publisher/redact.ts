/**
 * Defense in depth before anything is published: remove secret values the process itself holds, scrub common
 * credential shapes, and bound text sizes so a review can never carry a token or exceed GitHub's limits.
 * The reviewer is told to quote harmless substrings; this does not rely on it complying.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[redacted github token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted github token]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '[redacted api key]'],
  [/\bsk-[A-Za-z0-9]{32,}\b/g, '[redacted api key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted aws key id]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted slack token]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[redacted google api key]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted jwt]'],
  [/((?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']?)([^\s"'`]{12,})/gi, '$1[redacted]'],
];

export interface Redactor { apply(text: string): string }

/** Builds a redactor that knows the exact secret values this process holds plus the generic patterns. */
export function buildRedactor(heldSecrets: Array<string | undefined>): Redactor {
  const exact = heldSecrets.filter((s): s is string => typeof s === 'string' && s.trim().length >= 8).map((s) => s.trim());
  return {
    apply(text: string): string {
      let out = text;
      for (const value of exact) out = out.split(value).join('[redacted]');
      for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
      return out;
    },
  };
}

export function redactorFromEnv(env: NodeJS.ProcessEnv = process.env): Redactor {
  return buildRedactor([env['ANTHROPIC_API_KEY'], env['GITHUB_TOKEN'], env['GH_TOKEN'], env['FALCON_GITHUB_PRIVATE_KEY'], env['FALCON_GITHUB_WEBHOOK_SECRET']]);
}

/** Truncates on a UTF-8 boundary so a cut never emits an invalid sequence, and says that it cut. */
export function boundBytes(text: string, maxBytes: number): string {
  const marker = '\n… [truncated]';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  const buf = Buffer.from(text, 'utf8').subarray(0, budget);
  let end = buf.length;
  // Back up over a partial multi-byte sequence: continuation bytes are 10xxxxxx.
  while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) end--;
  if (end > 0 && (buf[end - 1]! & 0x80) !== 0) {
    // The byte before `end` starts a multi-byte sequence that we cut; drop it too.
    const lead = buf[end - 1]!;
    const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (expected > 1) end--;
  }
  return buf.subarray(0, end).toString('utf8') + marker;
}

/** GitHub's practical limits: 65,536 bytes per review body and per comment; we stay well under. */
export const LIMITS = { reviewBody: 60_000, comment: 8_000, summary: 3_000 } as const;

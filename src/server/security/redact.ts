/**
 * Gnito — redaction helpers.
 *
 * Used everywhere a secret could leak into a log, error, or export.
 * Pattern-based, conservative: matches common key formats (sk-..., ghp_..., etc.)
 * and a "key=value" fallback. Never perfect — docs/security.md documents the limits.
 */
const SECRET_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bsk-[A-Za-z0-9_-]{20,}/g, label: 'sk-…' },
  { re: /\bghp_[A-Za-z0-9]{30,}/g, label: 'github-token' },
  { re: /\bgho_[A-Za-z0-9]{30,}/g, label: 'github-oauth' },
  { re: /\bghs_[A-Za-z0-9]{30,}/g, label: 'github-secret' },
  { re: /\bAKIA[A-Z0-9]{16,}/g, label: 'AKIA…' },
  { re: /\bAIza[0-9A-Za-z_-]{30,}/g, label: 'AIza…' },
  { re: /\bxoxb-[0-9A-Za-z-]{20,}/g, label: 'xoxb-…' },
  { re: /\bBearer\s+[A-Za-z0-9._-]{20,}/gi, label: 'Bearer …' },
  { re: /\b(api[-_]?key|token|password|secret)["' ]*[:=]\s*["']?[A-Za-z0-9._-]{8,}["']?/gi, label: 'secret=…' },
];

/** Redact known secret formats from a string (logs, error messages, exports). */
export function redactSecrets(input: string): string {
  let out = input;
  for (const { re, label } of SECRET_PATTERNS) {
    out = out.replace(re, `[redacted:${label}]`);
  }
  return out;
}

/** Redact a JSON object's values (used for tool outputs before logging). */
export function redactObjectSecrets<T extends object>(obj: T): T {
  try {
    const s = redactSecrets(JSON.stringify(obj, null, 2));
    return JSON.parse(s) as T;
  } catch {
    return obj;
  }
}

/** Truncate a string to maxLen bytes (UTF-8 safe), appending an ellipsis marker. */
export function truncateForLog(s: string, maxLen = 4000): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxLen) return s;
  return buf.subarray(0, maxLen).toString('utf8') + '…[truncated]';
}

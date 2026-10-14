/**
 * Gnito — unit tests: security (redaction, path traversal).
 */
import { describe, it, expect } from 'vitest';
import { redactSecrets, truncateForLog } from '../../src/server/security/redact.js';
import path from 'node:path';

describe('redactSecrets', () => {
  it('redacts OpenAI-style keys', () => {
    const s = 'my key is sk-abcdefghijklmnopqrstuvwxyz123456';
    expect(redactSecrets(s)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(redactSecrets(s)).toContain('[redacted:sk-…]');
  });

  it('redacts GitHub tokens', () => {
    const s = 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    expect(redactSecrets(s)).not.toContain('ghp_');
  });

  it('redacts Bearer tokens', () => {
    const s = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc';
    expect(redactSecrets(s)).not.toContain('eyJhbGciOiJIUzI1Ni');
  });

  it('redacts key=value pairs', () => {
    const s = 'api_key = "supersecretvalue123"';
    expect(redactSecrets(s)).not.toContain('supersecretvalue123');
  });

  it('leaves normal text untouched', () => {
    const s = 'The quick brown fox jumps over the lazy dog';
    expect(redactSecrets(s)).toBe(s);
  });
});

describe('truncateForLog', () => {
  it('returns short strings unchanged', () => {
    expect(truncateForLog('short', 100)).toBe('short');
  });
  it('truncates long strings', () => {
    const long = 'a'.repeat(5000);
    const out = truncateForLog(long, 100);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });
});

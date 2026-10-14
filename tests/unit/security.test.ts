/**
 * Gnito — unit tests: security (redaction, path traversal).
 */
import { describe, it, expect } from 'vitest';
import { redactSecrets, truncateForLog } from '../../src/server/security/redact.js';
import { isTrustedOrigin } from '../../src/server/security/auth.js';
import type { Request } from 'express';

function requestWithOrigin(host: string, origin?: string): Request {
  return {
    header(name: string) {
      if (name.toLowerCase() === 'host') return host;
      if (name.toLowerCase() === 'origin') return origin;
      return undefined;
    },
  } as unknown as Request;
}

describe('isTrustedOrigin', () => {
  it('trusts loopback hosts by default', () => {
    expect(isTrustedOrigin(requestWithOrigin('127.0.0.1:8377'))).toBe(true);
  });

  it('allows separate localhost ports for the development frontend and API', () => {
    expect(isTrustedOrigin(requestWithOrigin('127.0.0.1:8377', 'http://localhost:5173'))).toBe(true);
  });

  it('rejects untrusted hosts and cross-site origins', () => {
    expect(isTrustedOrigin(requestWithOrigin('attacker.example'))).toBe(false);
    expect(isTrustedOrigin(requestWithOrigin('localhost:8377', 'https://attacker.example'))).toBe(false);
  });

  it('allows an explicitly configured exact network origin only when Host matches', () => {
    const trusted = ['https://gnito.example.com'];
    expect(isTrustedOrigin(requestWithOrigin('gnito.example.com', 'https://gnito.example.com'), trusted)).toBe(true);
    expect(isTrustedOrigin(requestWithOrigin('other.example.com', 'https://gnito.example.com'), trusted)).toBe(false);
    expect(isTrustedOrigin(requestWithOrigin('gnito.example.com', 'http://gnito.example.com'), trusted)).toBe(false);
  });

  it('rejects malformed origins', () => {
    expect(isTrustedOrigin(requestWithOrigin('localhost:8377', 'not a URL'))).toBe(false);
  });
});

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

/**
 * Gnito — security middleware.
 *
 * We validate Host/Origin against loopback hostnames by default, plus only
 * explicitly configured exact origins for deliberate network deployments.
 * DNS-rebinding protection depends on this allowlist being the trust root.
 */
import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { CONFIG } from '../config.js';

const SESSIONS = new Map<string, { createdAt: number; csrf: string }>();

/** Canonical loopback hostnames (with or without any port) we trust. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTNAMES.has(host)) return true;
  // Strip trailing port (e.g. 127.0.0.1:8377 → 127.0.0.1).
  const withoutPort = host.replace(/:\d+$/, '');
  return LOOPBACK_HOSTNAMES.has(withoutPort);
}

/** Session bootstrap nonce (one-time-use) to prevent replay. */
const BOOTSTRAP_NONCES = new Set<string>();

export function createSession(): { token: string; csrf: string } {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(32).toString('hex');
  SESSIONS.set(token, { createdAt: Date.now(), csrf });
  return { token, csrf };
}

export function validateSession(token: string | undefined): { csrf: string } | null {
  if (!token) return null;
  const s = SESSIONS.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > CONFIG.sessionTtlMs) {
    SESSIONS.delete(token);
    return null;
  }
  return { csrf: s.csrf };
}

export function revokeSession(token: string | undefined): void {
  if (token) SESSIONS.delete(token);
}

/** Generate a one-time bootstrap nonce (prevents session-endpoint replay). */
export function newBootstrapNonce(): string {
  const n = crypto.randomBytes(32).toString('hex');
  BOOTSTRAP_NONCES.add(n);
  setTimeout(() => BOOTSTRAP_NONCES.delete(n), 60_000).unref();
  return n;
}

export function consumeBootstrapNonce(n: string): boolean {
  return BOOTSTRAP_NONCES.delete(n);
}

/**
 * Validate Host (and Origin when present) against the canonical allowlist.
 * Returns true if the request is from a trusted origin.
 */
export function isTrustedOrigin(req: Request, configuredOrigins: readonly string[] = CONFIG.trustedOrigins): boolean {
  const host = (req.header('host') || '').toLowerCase();
  const trustedOrigins = new Set(configuredOrigins.map((value) => value.toLowerCase()));
  const trustedHosts = new Set(configuredOrigins.map((value) => new URL(value).host.toLowerCase()));
  const trustedHost = isLoopbackHost(host) || trustedHosts.has(host);
  if (!trustedHost) return false;

  const origin = (req.header('origin') || '').toLowerCase();
  if (!origin) return true; // GETs and non-browser clients may omit Origin.

  try {
    const parsedOrigin = new URL(origin);
    const originHost = parsedOrigin.host.toLowerCase();
    if (isLoopbackHost(host) && isLoopbackHost(originHost)) return true;
    return trustedOrigins.has(parsedOrigin.origin.toLowerCase()) && originHost === host;
  } catch {
    return false;
  }
}

const rateBuckets = new Map<string, { count: number; reset: number }>();

export function rateLimit(key: string, maxPerMinute: number = CONFIG.rateLimitPerMinute): boolean {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now > b.reset) {
    b = { count: 0, reset: now + 60_000 };
    rateBuckets.set(key, b);
  }
  b.count += 1;
  return b.count <= maxPerMinute;
}

/** Middleware: require session + CSRF + trusted origin. */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const token = req.header('x-gnito-session');
  const session = validateSession(token);
  if (!session) {
    res.status(401).json({ error: 'unauthorized', message: 'No valid session.' });
    return;
  }

  // CSRF token check (double-submit).
  const providedCsrf = req.header('x-gnito-csrf');
  if (!providedCsrf || providedCsrf !== session.csrf) {
    res.status(403).json({ error: 'csrf', message: 'CSRF token mismatch.' });
    return;
  }

  // Origin/Host allowlist.
  if (!isTrustedOrigin(req)) {
    res.status(403).json({ error: 'csrf', message: 'Untrusted origin.' });
    return;
  }

  if (!rateLimit(token!)) {
    res.status(429).json({ error: 'rate-limit', message: 'Too many requests.' });
    return;
  }

  (req as any).gnitoSession = session;
  next();
}

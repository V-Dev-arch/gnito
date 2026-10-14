/**
 * Gnito — runtime configuration, loaded from env + safe defaults.
 *
 * SECURITY: bind to loopback by default. Exposing to LAN/public is opt-in
 * via GNITO_HOST and requires explicit user understanding.
 */
import path from 'node:path';
import fs from 'node:fs';

const HOME = process.env.HOME || process.env.USERPROFILE || '/tmp';

/** Where Gnito stores all user data (SQLite DB, files, logs, secrets vault). */
export const DATA_DIR =
  process.env.GNITO_DATA_DIR || path.join(HOME, '.gnito');

export const CONFIG = {
  /** Bind address — 127.0.0.1 by default for security. */
  host: process.env.GNITO_HOST || '127.0.0.1',
  port: Number(process.env.GNITO_PORT || 8377),

  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, 'gnito.db'),
  secretsVaultPath: path.join(DATA_DIR, 'secrets.enc'),

  /** Max request body size (5 MB). */
  maxBodyBytes: 5 * 1024 * 1024,

  /** Session token TTL (24 h). */
  sessionTtlMs: 24 * 3600_000,

  /** Rate limit per endpoint per minute. */
  rateLimitPerMinute: 120 as number,

  /** Max backup archive plaintext size (200 MB). */
  maxBackupPlaintextBytes: 200 * 1024 * 1024,
} as const;

export function ensureDataDir(): void {
  if (!fs.existsSync(CONFIG.dataDir)) {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true, mode: 0o700 });
  }
}

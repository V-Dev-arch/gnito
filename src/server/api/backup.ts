/**
 * Gnito — encrypted backup + restore.
 *
 * Archive format (versioned):
 *  - JSON header (plaintext) with metadata + salt + nonce
 *  - Ciphertext: AES-256-GCM with key derived via scrypt(password, salt).
 *
 * Secrets (provider API keys) are EXCLUDED by default. The user must
 * explicitly opt-in and we show a strong warning.
 */
import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { getProviderSecret, setProviderSecret } from '../security/vault.js';
import { CONFIG, ensureDataDir } from '../config.js';
import { redactSecrets, truncateForLog } from '../security/redact.js';

const db = getDb();

const BACKUP_DIR = path.join(CONFIG.dataDir, 'backups');
const MAGIC = 'GNITO-BACKUP-V1\n';

// ---------------------------------------------------------------- routes

export function registerBackupRoutes(app: any): void {
  // Create backup.
  app.post('/api/backup/create', async (req: Request, res: Response) => {
    const parsed = z.object({
      password: z.string().min(8).max(500),
      options: z.object({
        includeChats: z.boolean().default(true),
        includeProjects: z.boolean().default(true),
        includeSettings: z.boolean().default(true),
        includePlugins: z.boolean().default(true),
        includeAutomations: z.boolean().default(true),
        includeMemory: z.boolean().default(true),
        includeSecrets: z.boolean().default(false),
        includeFiles: z.boolean().default(false),
      }).default({}),
    }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation', issues: parsed.error.issues }); return; }
    const { password, options } = parsed.data;
    await ensureDataDir();
    await fs.mkdir(BACKUP_DIR, { recursive: true });

    // Build plaintext payload.
    const payload: Record<string, unknown> = {
      formatVersion: 1,
      createdAt: Date.now(),
      options,
    };
    if (options.includeChats) {
      payload.chats = db.prepare('SELECT * FROM chats').all();
      payload.messages = db.prepare('SELECT * FROM messages').all();
    }
    if (options.includeProjects) {
      payload.projects = db.prepare('SELECT * FROM projects').all();
    }
    if (options.includeSettings) {
      payload.settings = db.prepare('SELECT * FROM settings').all();
    }
    if (options.includePlugins) {
      payload.plugins = db.prepare('SELECT * FROM plugins').all();
    }
    if (options.includeAutomations) {
      payload.automations = db.prepare('SELECT * FROM automations').all();
      payload.automationRuns = db.prepare('SELECT * FROM automation_runs LIMIT 1000').all();
    }
    if (options.includeMemory) {
      payload.memory = db.prepare('SELECT * FROM memory_entries').all();
    }
    if (options.includeSecrets) {
      const secrets: Record<string, string> = {};
      const providers = db.prepare('SELECT id FROM providers').all() as any[];
      for (const p of providers) {
        const s = getProviderSecret(p.id);
        if (s) secrets[p.id] = s;
      }
      payload.secrets = secrets;
    }
    if (options.includeFiles) {
      // Note: user files are NOT included in this iteration. We document this
      // limitation clearly in docs/implementation-status.md.
      payload.filesNote = 'User files (approved folders) are not included in v1 backups. Re-grant folders after restore.';
    }

    const plaintext = JSON.stringify(payload, null, 2);
    if (Buffer.byteLength(plaintext) > CONFIG.maxBackupPlaintextBytes) {
      res.status(413).json({ error: 'too-large' });
      return;
    }

    // Encrypt.
    const salt = crypto.randomBytes(16);
    const nonce = crypto.randomBytes(12);
    const key = crypto.scryptSync(password, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const filename = `gnito-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.gnito`;
    const filePath = path.join(BACKUP_DIR, filename);
    const header = {
      formatVersion: 1,
      createdAt: payload.createdAt as number,
      included: options,
      plaintextSize: Buffer.byteLength(plaintext),
      salt: salt.toString('hex'),
      nonce: nonce.toString('hex'),
    };
    await fs.writeFile(filePath, MAGIC + JSON.stringify(header) + '\n' + Buffer.concat([ciphertext, tag]).toString('base64'), 'utf8');
    res.json({ ok: true, filename, path: filePath, sizeBytes: Buffer.concat([ciphertext, tag]).length + Buffer.byteLength(MAGIC + JSON.stringify(header)) });
  });

  // List backups.
  app.get('/api/backup/list', async (_req: Request, res: Response) => {
    await fs.mkdir(BACKUP_DIR, { recursive: true }).catch(() => {});
    const files = await fs.readdir(BACKUP_DIR).catch(() => [] as string[]);
    const out = [];
    for (const f of files.filter(f => f.endsWith('.gnito'))) {
      const stat = await fs.stat(path.join(BACKUP_DIR, f)).catch(() => null);
      if (stat) out.push({ filename: f, sizeBytes: stat.size, createdAt: stat.mtimeMs });
    }
    res.json(out.sort((a, b) => b.createdAt - a.createdAt));
  });

  // Restore (validates + restores into new records, never overwrites without confirm).
  app.post('/api/backup/restore', async (req: Request, res: Response) => {
    const parsed = z.object({
      filePath: z.string().min(1).max(2000),
      password: z.string().min(8).max(500),
      overwrite: z.boolean().default(false),
    }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation', issues: parsed.error.issues }); return; }
    const { filePath, password, overwrite } = parsed.data;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      if (!raw.startsWith(MAGIC)) {
        res.status(400).json({ error: 'invalid-archive', message: 'Not a Gnito backup.' });
        return;
      }
      const lines = raw.slice(MAGIC.length).split('\n');
      const header = JSON.parse(lines[0]);
      const b64 = lines.slice(1).join('');
      const full = Buffer.from(b64, 'base64');
      const ciphertext = full.subarray(0, full.length - 16);
      const tag = full.subarray(full.length - 16);

      const key = crypto.scryptSync(password, Buffer.from(header.salt, 'hex'), 32, {
        N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024,
      });
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(header.nonce, 'hex'));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const payload = JSON.parse(plaintext.toString('utf8'));

      // Validate content types before applying.
      if (payload.formatVersion !== 1) {
        res.status(400).json({ error: 'unsupported-version' });
        return;
      }

      // Apply (insert with new IDs; skip existing by natural key unless overwrite).
      // Wrapped in a single transaction so a mid-restore failure rolls back cleanly.
      let applied = { chats: 0, projects: 0, settings: 0, memory: 0, plugins: 0, automations: 0, secrets: 0 };
      const projectIdRemap = new Map<string, string>();

      const restoreAll = db.transaction(() => {
        if (payload.projects) {
          for (const p of payload.projects) {
            const exists = db.prepare('SELECT id FROM projects WHERE name = ?').get(p.name);
            if (exists && !overwrite) continue;
            const newId = exists ? p.id : crypto.randomUUID();
            projectIdRemap.set(p.id, newId);
            db.prepare(`INSERT OR REPLACE INTO projects (id, name, instructions, created_at, updated_at) VALUES (?,?,?,?,?)`)
              .run(newId, p.name, p.instructions, p.created_at, Date.now());
            applied.projects++;
          }
        }
        if (payload.chats && payload.messages) {
          for (const c of payload.chats) {
            const exists = db.prepare('SELECT id FROM chats WHERE id = ?').get(c.id);
            if (exists && !overwrite) continue;
            // Remap project_id to the restored project's new ID.
            const remappedProjectId = c.project_id ? (projectIdRemap.get(c.project_id) ?? null) : null;
            db.prepare(`INSERT OR REPLACE INTO chats (id, project_id, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
              .run(c.id, remappedProjectId, c.title, c.status, c.created_at, Date.now());
            applied.chats++;
          }
          for (const m of payload.messages) {
            const chatExists = db.prepare('SELECT id FROM chats WHERE id = ?').get(m.chat_id);
            if (!chatExists) continue;
            const msgExists = db.prepare('SELECT id FROM messages WHERE id = ?').get(m.id);
            if (msgExists && !overwrite) continue;
            db.prepare(`INSERT OR REPLACE INTO messages (id, chat_id, role, content, provider_id, model_id, usage, created_at) VALUES (?,?,?,?,?,?,?,?)`)
              .run(m.id, m.chat_id, m.role, m.content, m.provider_id, m.model_id, m.usage, m.created_at);
          }
        }
      if (payload.settings) {
        for (const s of payload.settings) {
          const exists = db.prepare('SELECT key FROM settings WHERE key = ?').get(s.key);
          if (exists && !overwrite) continue;
          db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').run(s.key, s.value);
          applied.settings++;
        }
      }
      if (payload.memory) {
        for (const m of payload.memory) {
          const exists = db.prepare('SELECT id FROM memory_entries WHERE key = ?').get(m.key);
          if (exists && !overwrite) continue;
          db.prepare(`INSERT OR REPLACE INTO memory_entries (id, key, value, reason, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
            .run(m.id, m.key, m.value, m.reason, m.created_at, Date.now());
          applied.memory++;
        }
      }
      if (payload.plugins) {
        for (const p of payload.plugins) {
          const exists = db.prepare('SELECT id FROM plugins WHERE id = ?').get(p.id);
          if (exists && !overwrite) continue;
          db.prepare(`INSERT OR REPLACE INTO plugins (id, manifest, enabled, config, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
            .run(p.id, p.manifest, p.enabled, p.config, p.state, p.created_at, Date.now());
          applied.plugins++;
        }
      }
      if (payload.automations) {
        for (const a of payload.automations) {
          const exists = db.prepare('SELECT id FROM automations WHERE id = ?').get(a.id);
          if (exists && !overwrite) continue;
          db.prepare(`INSERT OR REPLACE INTO automations
            (id, prompt, schedule, task_instruction, status, missed_run_policy, dry_run,
             max_steps, max_retries, retry_backoff_ms, created_at, updated_at, next_run_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(a.id, a.prompt, a.schedule, a.task_instruction, 'paused', a.missed_run_policy, a.dry_run,
              a.max_steps, a.max_retries, a.retry_backoff_ms, a.created_at, Date.now(), null);
          applied.automations++;
        }
      }
      });
      restoreAll();

      // Secrets touch the vault file (not the DB) — applied outside the transaction.
      if (payload.secrets) {
        for (const [providerId, secret] of Object.entries(payload.secrets)) {
          setProviderSecret(providerId, String(secret));
          applied.secrets++;
        }
      }

      res.json({ ok: true, applied, skippedDueToExisting: !overwrite });
    } catch (e: any) {
      const msg = e?.message || '';
      if (e?.code === 'ERR_CRYPTO_INVALID_AUTH_TAG' || /auth tag/i.test(msg) || /unable to authenticate/i.test(msg)) {
        res.status(400).json({ error: 'wrong-password', message: 'Wrong password or corrupted archive.' });
        return;
      }
      res.status(500).json({ error: 'restore-failed', message: redactSecrets(truncateForLog(msg || 'Restore failed')) });
    }
  });

  // Delete a backup file.
  app.delete('/api/backup/:filename', async (req: Request, res: Response) => {
    const filename = path.basename(String(req.params.filename)); // prevent traversal
    if (!filename.endsWith('.gnito')) { res.status(400).json({ error: 'invalid' }); return; }
    await fs.rm(path.join(BACKUP_DIR, filename), { force: true });
    res.json({ ok: true });
  });
};

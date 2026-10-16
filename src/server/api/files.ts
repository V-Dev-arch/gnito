/**
 * Gnito — local file access API.
 *
 * SECURITY:
 *  - Only folders the user explicitly approved (via `file_grants`) are
 *    accessible. All paths are resolved (symlinks followed) and validated
 *    to be inside an approved root.
 *  - Path traversal (`..`) is rejected at input validation.
 *  - Destructive ops (write, delete, move) require a confirmation token
 *    issued in advance by the user.
 */
import type { Request, Response } from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { redactSecrets } from '../security/redact.js';

const db = getDb();

const MAX_READ_BYTES = 5 * 1024 * 1024;   // 5 MB per read
const MAX_WRITE_BYTES = 5 * 1024 * 1024;  // 5 MB per write

// ---------------------------------------------------------- path safety

/** Resolve a path and ensure it is inside one of the approved roots. */
function safeResolve(userPath: string): { resolved: string; root: string } | null {
  // Reject absolute paths going outside our control and null bytes.
  if (userPath.includes('\0')) return null;
  // Normalize (does not follow symlinks yet).
  const normalized = path.normalize(userPath);
  if (normalized.startsWith('..')) return null;

  const grants = db.prepare('SELECT * FROM file_grants').all() as any[];
  for (const grant of grants) {
    const root = path.resolve(grant.root_path);
    const candidate = path.resolve(root, normalized);
    // Symlink-aware check: both real paths.
    try {
      const realRoot = fsSync.realpathSync(root);
      const realCandidate = fsSync.realpathSync(candidate);
      if (realCandidate === realRoot || realCandidate.startsWith(realRoot + path.sep)) {
        return { resolved: candidate, root: realRoot };
      }
    } catch {
      // Candidate doesn't exist yet (write case) — check lexical containment only.
      if (candidate === root || candidate.startsWith(root + path.sep)) {
        return { resolved: candidate, root };
      }
    }
  }
  return null;
}

// ------------------------------------------------------------- routes

export function registerFileRoutes(app: any): void {
  // List approved folders (grants).
  app.get('/api/files/grants', (_req: Request, res: Response) => {
    const rows = db.prepare('SELECT * FROM file_grants').all() as any[];
    res.json(rows.map(r => ({
      id: r.id, rootPath: r.root_path, label: r.label,
      permissions: JSON.parse(r.permissions || '[]'),
      createdAt: r.created_at,
    })));
  });

  // Add an approved folder grant.
  app.post('/api/files/grants', (req: Request, res: Response) => {
    const parsed = z.object({
      rootPath: z.string().min(1).max(1000),
      label: z.string().min(1).max(200),
      permissions: z.array(z.enum(['files:read', 'files:write', 'files:delete'])).min(1),
    }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation' }); return; }

    const abs = path.resolve(parsed.data.rootPath);
    if (!fsSync.existsSync(abs) || !fsSync.statSync(abs).isDirectory()) {
      res.status(400).json({ error: 'not-a-directory' });
      return;
    }
    const id = randomUUID();
    db.prepare('INSERT INTO file_grants (id, root_path, label, permissions, created_at) VALUES (?,?,?,?,?)')
      .run(id, abs, parsed.data.label, JSON.stringify(parsed.data.permissions), Date.now());
    res.status(201).json({ id });
  });

  app.delete('/api/files/grants/:id', (req: Request, res: Response) => {
    const info = db.prepare('DELETE FROM file_grants WHERE id = ?').run(req.params.id);
    res.json({ ok: info.changes > 0 });
  });

  // List files in an approved folder.
  app.get('/api/files/list', (req: Request, res: Response) => {
    const rel = String(req.query.path || '.');
    const safe = safeResolve(rel);
    if (!safe) { res.status(403).json({ error: 'outside-approved-roots' }); return; }
    try {
      const entries = fsSync.readdirSync(safe.resolved, { withFileTypes: true });
      const out = entries.map(e => ({
        name: e.name,
        isDir: e.isDirectory(),
        size: e.isFile() ? fsSync.statSync(path.join(safe.resolved, e.name)).size : 0,
      })).sort((a, b) => (b.isDir ? 1 : 0) - (a.isDir ? 1 : 0) || a.name.localeCompare(b.name));
      res.json({ entries: out, root: safe.root });
    } catch (e: any) {
      res.status(404).json({ error: 'read-failed', message: redactSecrets(e.message) });
    }
  });

  // Read a file (text only, size-capped).
  app.get('/api/files/read', (req: Request, res: Response) => {
    const rel = String(req.query.path || '');
    if (!rel) { res.status(400).json({ error: 'missing-path' }); return; }
    const safe = safeResolve(rel);
    if (!safe) { res.status(403).json({ error: 'outside-approved-roots' }); return; }
    try {
      const stat = fsSync.statSync(safe.resolved);
      if (!stat.isFile()) { res.status(400).json({ error: 'not-a-file' }); return; }
      if (stat.size > MAX_READ_BYTES) {
        res.status(413).json({ error: 'too-large', message: `File exceeds ${MAX_READ_BYTES} bytes.` });
        return;
      }
      const content = fsSync.readFileSync(safe.resolved, 'utf8');
      res.json({ path: rel, content, size: stat.size });
    } catch (e: any) {
      res.status(404).json({ error: 'read-failed', message: redactSecrets(e.message) });
    }
  });

  // Write a file — requires `confirmation` token issued via /confirm.
  app.put('/api/files/write', async (req: Request, res: Response) => {
    const parsed = z.object({
      path: z.string().min(1).max(2000),
      content: z.string().max(MAX_WRITE_BYTES),
      confirmation: z.string().min(20),
    }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation' }); return; }
    const safe = safeResolve(parsed.data.path);
    if (!safe) { res.status(403).json({ error: 'outside-approved-roots' }); return; }
    // Verify confirmation token.
    const row = db.prepare(`SELECT * FROM tool_runs WHERE id = ? AND status = 'pending-approval' AND tool = 'files:write'`)
      .get(parsed.data.confirmation) as any;
    if (!row) { res.status(403).json({ error: 'invalid-confirmation' }); return; }
    try {
      await fs.mkdir(path.dirname(safe.resolved), { recursive: true });
      await fs.writeFile(safe.resolved, parsed.data.content, 'utf8');
      db.prepare(`UPDATE tool_runs SET status='succeeded', ended_at=?, output=? WHERE id=?`)
        .run(Date.now(), JSON.stringify({ path: rel(parsed.data.path), bytes: parsed.data.content.length }), parsed.data.confirmation);
      res.json({ ok: true, path: parsed.data.path, bytes: parsed.data.content.length });
    } catch (e: any) {
      db.prepare(`UPDATE tool_runs SET status='failed', ended_at=?, error=? WHERE id=?`)
        .run(Date.now(), redactSecrets(e.message), parsed.data.confirmation);
      res.status(500).json({ error: 'write-failed', message: redactSecrets(e.message) });
    }
  });

  // Delete a file — requires confirmation token.
  app.delete('/api/files/delete', async (req: Request, res: Response) => {
    const parsed = z.object({
      path: z.string().min(1).max(2000),
      confirmation: z.string().min(20),
    }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation' }); return; }
    const safe = safeResolve(parsed.data.path);
    if (!safe) { res.status(403).json({ error: 'outside-approved-roots' }); return; }
    const row = db.prepare(`SELECT * FROM tool_runs WHERE id = ? AND status = 'pending-approval' AND tool = 'files:delete'`)
      .get(parsed.data.confirmation) as any;
    if (!row) { res.status(403).json({ error: 'invalid-confirmation' }); return; }
    try {
      await fs.unlink(safe.resolved);
      db.prepare(`UPDATE tool_runs SET status='succeeded', ended_at=? WHERE id=?`).run(Date.now(), parsed.data.confirmation);
      res.json({ ok: true, deleted: parsed.data.path });
    } catch (e: any) {
      db.prepare(`UPDATE tool_runs SET status='failed', ended_at=?, error=? WHERE id=?`)
        .run(Date.now(), redactSecrets(e.message), parsed.data.confirmation);
      res.status(500).json({ error: 'delete-failed', message: redactSecrets(e.message) });
    }
  });
}

function rel(p: string): string { return p; } // placeholder to keep TS happy

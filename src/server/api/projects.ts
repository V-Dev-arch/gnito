/**
 * Gnito — projects (workspaces).
 */
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db/index.js';

const db = getDb();

const CreateProjectInput = z.object({
  name: z.string().min(1).max(200),
  instructions: z.string().max(5000).default(''),
});

export function registerProjectRoutes(app: any): void {
  app.get('/api/projects', (_req: Request, res: Response) => {
    const rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as any[];
    res.json(rows.map(r => ({
      id: r.id, name: r.name, instructions: r.instructions,
      createdAt: r.created_at, updatedAt: r.updated_at,
    })));
  });

  app.post('/api/projects', (req: Request, res: Response) => {
    const parsed = CreateProjectInput.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation' }); return; }
    const id = randomUUID();
    const now = Date.now();
    db.prepare('INSERT INTO projects (id, name, instructions, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(id, parsed.data.name, parsed.data.instructions, now, now);
    res.status(201).json({ id });
  });

  app.patch('/api/projects/:id', (req: Request, res: Response) => {
    const UpdateInput = z.object({
      name: z.string().min(1).max(200).optional(),
      instructions: z.string().max(5000).optional(),
    });
    const parsed = UpdateInput.safeParse(req.body || {});
    if (!parsed.success) { res.status(400).json({ error: 'validation' }); return; }
    const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as any;
    if (!existing) { res.status(404).json({ error: 'not-found' }); return; }
    db.prepare('UPDATE projects SET name=?, instructions=?, updated_at=? WHERE id=?').run(
      parsed.data.name ?? existing.name,
      parsed.data.instructions ?? existing.instructions,
      Date.now(),
      req.params.id,
    );
    res.json({ ok: true });
  });

  app.delete('/api/projects/:id', (req: Request, res: Response) => {
    // Chats in this project get project_id=NULL via FK.
    const info = db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    res.json({ ok: info.changes > 0 });
  });
};

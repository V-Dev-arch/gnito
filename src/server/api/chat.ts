/**
 * Gnito — chat persistence endpoints.
 * Incognito chats never hit this layer; see incognito.ts.
 */
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db/index.js';

const db = getDb();

const CreateChatInput = z.object({
  title: z.string().min(1).max(300).default('New chat'),
  projectId: z.string().nullable().default(null),
});

const SendMessageInput = z.object({
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string().min(1).max(200_000),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
});

export function registerChatRoutes(app: any): void {
  app.get('/api/chats', (req: Request, res: Response) => {
    const status = req.query.status === 'archived' ? 'archived' : 'active';
    const projectId = req.query.projectId ? String(req.query.projectId) : null;
    let sql = `SELECT * FROM chats WHERE status = ?`;
    const params: any[] = [status];
    if (projectId) { sql += ` AND project_id = ?`; params.push(projectId); }
    sql += ` ORDER BY updated_at DESC LIMIT 500`;
    const rows = db.prepare(sql).all(...params) as any[];
    res.json(rows.map(r => ({
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })));
  });

  app.post('/api/chats', (req: Request, res: Response) => {
    const parsed = CreateChatInput.safeParse(req.body || {});
    if (!parsed.success) { res.status(400).json({ error: 'validation' }); return; }
    const { title, projectId } = parsed.data;
    const id = randomUUID();
    const now = Date.now();
    db.prepare(`INSERT INTO chats (id, project_id, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
      .run(id, projectId, title, 'active', now, now);
    res.status(201).json({ id });
  });

  app.get('/api/chats/:id', (req: Request, res: Response) => {
    const row = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    const messages = db.prepare(`SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC, id ASC`).all(req.params.id) as any[];
    res.json({
      chat: { id: row.id, projectId: row.project_id, title: row.title, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at },
      messages: messages.map(m => ({
        id: m.id, role: m.role, content: m.content, providerId: m.provider_id,
        modelId: m.model_id, usage: m.usage ? JSON.parse(m.usage) : undefined, createdAt: m.created_at,
      })),
    });
  });

  app.patch('/api/chats/:id', (req: Request, res: Response) => {
    const UpdateInput = z.object({
      title: z.string().min(1).max(300).optional(),
      projectId: z.string().nullable().optional(),
      status: z.enum(['active', 'archived']).optional(),
    });
    const parsed = UpdateInput.safeParse(req.body || {});
    if (!parsed.success) { res.status(400).json({ error: 'validation' }); return; }
    const existing = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id) as any;
    if (!existing) { res.status(404).json({ error: 'not-found' }); return; }
    const p = parsed.data;
    db.prepare(`UPDATE chats SET title=?, project_id=?, status=?, updated_at=? WHERE id=?`).run(
      p.title ?? existing.title,
      p.projectId === undefined ? existing.project_id : p.projectId,
      p.status ?? existing.status,
      Date.now(),
      req.params.id,
    );
    res.json({ ok: true });
  });

  app.delete('/api/chats/:id', (req: Request, res: Response) => {
    // Cascade deletes messages via FK.
    const info = db.prepare('DELETE FROM chats WHERE id = ?').run(req.params.id);
    res.json({ ok: info.changes > 0, deleted: info.changes });
  });

  app.get('/api/chats/:id/messages', (req: Request, res: Response) => {
    const rows = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC').all(req.params.id) as any[];
    res.json(rows.map(m => ({
      id: m.id, role: m.role, content: m.content, providerId: m.provider_id,
      modelId: m.model_id, usage: m.usage ? JSON.parse(m.usage) : undefined, createdAt: m.created_at,
    })));
  });

  app.post('/api/chats/:id/messages', (req: Request, res: Response) => {
    const parsed = SendMessageInput.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation' }); return; }
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id) as any;
    if (!chat) { res.status(404).json({ error: 'not-found' }); return; }
    const id = randomUUID();
    db.prepare(`INSERT INTO messages (id, chat_id, role, content, provider_id, model_id, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, req.params.id, parsed.data.role, parsed.data.content, parsed.data.providerId ?? null, parsed.data.modelId ?? null, Date.now());
    db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Date.now(), req.params.id);
    res.status(201).json({ id });
  });

  // Delete a single message.
  app.delete('/api/messages/:id', (req: Request, res: Response) => {
    const info = db.prepare('DELETE FROM messages WHERE id = ?').run(req.params.id);
    res.json({ ok: info.changes > 0 });
  });

  // Search chat titles + message content.
  app.get('/api/search', (req: Request, res: Response) => {
    const q = String(req.query.q || '').trim();
    if (!q) { res.json([]); return; }
    const esc = `%${q.replace(/[_%]/g, '\\$&')}%`;
    const rows = db.prepare(`
      SELECT c.id AS chat_id, c.title, m.role, m.content, c.updated_at
      FROM chats c JOIN messages m ON m.chat_id = c.id
      WHERE (m.content LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\')
        AND c.status = 'active'
      ORDER BY c.updated_at DESC LIMIT 100
    `).all(esc, esc) as any[];
    res.json(rows);
  });
}

/**
 * Gnito — Incognito Mode.
 *
 * Incognito chats are held in memory only. They:
 *  - never write to the `chats` / `messages` tables
 *  - never update memory
 *  - never appear in backups
 *  - never appear in tool runs with an incognito context
 */
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';

interface IncognitoMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

interface IncognitoSession {
  id: string;
  messages: IncognitoMessage[];
  createdAt: number;
  /** Temp files created during the incognito session — deleted on exit. */
  tempFiles: string[];
}

const SESSIONS = new Map<string, IncognitoSession>();

export function registerIncognitoRoutes(app: any): void {
  app.post('/api/incognito/start', (_req: Request, res: Response) => {
    const id = randomUUID();
    SESSIONS.set(id, { id, messages: [], createdAt: Date.now(), tempFiles: [] });
    res.json({ sessionId: id });
  });

  app.post('/api/incognito/:id/message', (req: Request, res: Response) => {
    const s = SESSIONS.get(req.params.id);
    if (!s) { res.status(404).json({ error: 'session-expired' }); return; }
    const parsed = z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().min(1).max(200_000),
    }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation' }); return; }
    const id = randomUUID();
    s.messages.push({ id, ...parsed.data, createdAt: Date.now() });
    res.json({ id });
  });

  app.get('/api/incognito/:id', (req: Request, res: Response) => {
    const s = SESSIONS.get(req.params.id);
    if (!s) { res.status(404).json({ error: 'session-expired' }); return; }
    res.json({ messages: s.messages });
  });

  app.post('/api/incognito/:id/exit', (req: Request, res: Response) => {
    const s = SESSIONS.get(req.params.id);
    if (!s) { res.status(404).json({ error: 'session-expired' }); return; }
    // Delete temp files (best effort).
    for (const f of s.tempFiles) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
    SESSIONS.delete(req.params.id);
    res.json({ ok: true, discarded: true });
  });

  // Diagnostic: active incognito sessions (no content).
  app.get('/api/incognito/count', (_req: Request, res: Response) => {
    res.json({ activeSessions: SESSIONS.size });
  });
}

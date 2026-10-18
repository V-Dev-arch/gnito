/**
 * Gnito — Incognito Mode.
 *
 * Incognito chats live only in a bounded in-memory map. They never write to
 * chats/messages, memory, backups, or normal tool-run history. Sessions are
 * scoped to the authenticated browser session and expire automatically.
 */
import type { Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
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
  ownerHash: string;
  messages: IncognitoMessage[];
  createdAt: number;
  lastActivityAt: number;
  totalChars: number;
  /** Temp files created during the incognito session — deleted on exit/expiry. */
  tempFiles: string[];
}

const SESSIONS = new Map<string, IncognitoSession>();
const INACTIVITY_TTL_MS = 30 * 60_000;
const MAX_LIFETIME_MS = 12 * 60 * 60_000;
const MAX_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 200_000;
const MAX_SESSION_CHARS = 1_000_000;
const MAX_SESSIONS_PER_OWNER = 5;
const MAX_SESSIONS_TOTAL = 20;

function ownerHash(req: Request): string | null {
  const token = req.header('x-gnito-session');
  return token ? createHash('sha256').update(token).digest('hex') : null;
}

function deleteSession(id: string): void {
  const session = SESSIONS.get(id);
  if (!session) return;
  for (const file of session.tempFiles) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }
  SESSIONS.delete(id);
}

function removeExpiredSessions(now = Date.now()): void {
  for (const session of SESSIONS.values()) {
    if (now - session.lastActivityAt >= INACTIVITY_TTL_MS || now - session.createdAt >= MAX_LIFETIME_MS) {
      deleteSession(session.id);
    }
  }
}

const expiryTimer = setInterval(() => removeExpiredSessions(), 60_000);
expiryTimer.unref?.();

function getOwnedSession(req: Request, res: Response, id: string): IncognitoSession | null {
  removeExpiredSessions();
  const owner = ownerHash(req);
  if (!owner) { res.status(401).json({ error: 'unauthorized' }); return null; }
  const session = SESSIONS.get(id);
  // Return not-found for both missing IDs and IDs owned by another session.
  if (!session || session.ownerHash !== owner) { res.status(404).json({ error: 'session-expired' }); return null; }
  session.lastActivityAt = Date.now();
  return session;
}

export function registerIncognitoRoutes(app: any): void {
  app.post('/api/incognito/start', (req: Request, res: Response) => {
    removeExpiredSessions();
    const owner = ownerHash(req);
    if (!owner) { res.status(401).json({ error: 'unauthorized' }); return; }
    const ownerSessionCount = Array.from(SESSIONS.values()).filter(session => session.ownerHash === owner).length;
    if (SESSIONS.size >= MAX_SESSIONS_TOTAL || ownerSessionCount >= MAX_SESSIONS_PER_OWNER) {
      res.status(429).json({ error: 'session-limit', message: 'Too many temporary sessions are active. Exit an open session and try again.' });
      return;
    }
    const id = randomUUID();
    const now = Date.now();
    SESSIONS.set(id, { id, ownerHash: owner, messages: [], createdAt: now, lastActivityAt: now, totalChars: 0, tempFiles: [] });
    res.json({ sessionId: id, expiresInMs: INACTIVITY_TTL_MS });
  });

  app.post('/api/incognito/:id/message', (req: Request, res: Response) => {
    const session = getOwnedSession(req, res, req.params.id);
    if (!session) return;
    const parsed = z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().min(1).max(MAX_MESSAGE_CHARS),
    }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation' }); return; }
    if (session.messages.length >= MAX_MESSAGES || session.totalChars + parsed.data.content.length > MAX_SESSION_CHARS) {
      res.status(413).json({ error: 'session-limit', message: 'This temporary session reached its in-memory size limit. Exit and start a new session.' });
      return;
    }
    const id = randomUUID();
    session.messages.push({ id, ...parsed.data, createdAt: Date.now() });
    session.totalChars += parsed.data.content.length;
    res.json({ id });
  });

  // Diagnostic: expose only this authenticated owner’s active session count.
  // Register before `/:id` so the literal `count` path is not treated as an ID.
  app.get('/api/incognito/count', (req: Request, res: Response) => {
    removeExpiredSessions();
    const owner = ownerHash(req);
    if (!owner) { res.status(401).json({ error: 'unauthorized' }); return; }
    const activeSessions = Array.from(SESSIONS.values()).filter(session => session.ownerHash === owner).length;
    res.json({ activeSessions });
  });

  app.get('/api/incognito/:id', (req: Request, res: Response) => {
    const session = getOwnedSession(req, res, req.params.id);
    if (!session) return;
    res.json({ messages: session.messages });
  });

  app.post('/api/incognito/:id/exit', (req: Request, res: Response) => {
    const session = getOwnedSession(req, res, req.params.id);
    if (!session) return;
    deleteSession(session.id);
    res.json({ ok: true, discarded: true });
  });

}

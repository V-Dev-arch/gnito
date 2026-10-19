import { describe, it, expect, beforeEach } from 'vitest';
import { createServer, type AddressInfo } from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gnito-security-test-'));
process.env.GNITO_DATA_DIR = TEST_DIR;
process.env.GNITO_MASTER_KEY = randomUUID().replace(/-/g, '').repeat(2).slice(0, 64);

const { getDb } = await import('../../src/server/db/index.js');
const { createApp } = await import('../../src/server/api/app.js');
const { createSession } = await import('../../src/server/security/auth.js');

interface TestSession { token: string; csrf: string }

async function withServer<T>(handler: any, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function headers(session: TestSession, json = false): Record<string, string> {
  return {
    'X-Gnito-Session': session.token,
    'X-Gnito-CSRF': session.csrf,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

function createProviderPayload(baseUrl: string, kind = 'custom') {
  return {
    kind,
    label: 'Security test provider',
    baseUrl,
    customHeaders: { Authorization: 'Bearer private-header-value' },
    enabled: true,
  };
}

describe('provider response safety', () => {
  let app: ReturnType<typeof createApp>;
  let session: TestSession;

  beforeEach(() => {
    getDb().exec('DELETE FROM providers');
    app = createApp();
    session = createSession();
  });

  it('never returns custom authorization headers and blocks preset chat without a vault key', async () => {
    await withServer(app, async baseUrl => {
      const credentialUrlResponse = await fetch(`${baseUrl}/api/providers`, {
        method: 'POST', headers: headers(session, true),
        body: JSON.stringify(createProviderPayload('https://user:embedded-secret@api.example.invalid/v1')),
      });
      expect(credentialUrlResponse.status).toBe(400);

      const createdResponse = await fetch(`${baseUrl}/api/providers`, {
        method: 'POST', headers: headers(session, true), body: JSON.stringify(createProviderPayload('https://api.example.invalid/v1', 'openai-compatible')),
      });
      expect(createdResponse.status).toBe(201);
      const { id } = await createdResponse.json() as { id: string };

      const listResponse = await fetch(`${baseUrl}/api/providers`, { headers: headers(session) });
      const listText = await listResponse.text();
      expect(listText).not.toContain('private-header-value');
      expect(listText).not.toContain('customHeaders');

      const chatResponse = await fetch(`${baseUrl}/api/providers/${id}/chat`, {
        method: 'POST', headers: headers(session, true),
        body: JSON.stringify({ model: 'manual-model-id', messages: [{ role: 'user', content: 'hello' }] }),
      });
      expect(chatResponse.status).toBe(400);
      expect(await chatResponse.json()).toMatchObject({ error: 'missing-key' });
    });
  });

  it('identifies upstream 429s from the tool-enabled provider path without exposing the response body', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
      res.end(JSON.stringify({ error: { message: 'UPSTREAM_PRIVATE_RATE_LIMIT_BODY' } }));
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    try {
      await withServer(app, async baseUrl => {
        const createdResponse = await fetch(`${baseUrl}/api/providers`, {
          method: 'POST', headers: headers(session, true), body: JSON.stringify(createProviderPayload(`http://127.0.0.1:${upstreamPort}/v1`)),
        });
        const { id } = await createdResponse.json() as { id: string };
        const chatId = randomUUID();
        getDb().prepare('INSERT INTO chats (id, project_id, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?)')
          .run(chatId, null, 'Rate limit test', 'active', Date.now(), Date.now());

        const response = await fetch(`${baseUrl}/api/providers/${id}/chat`, {
          method: 'POST', headers: headers(session, true),
          body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'Check the network.' }], chatId, allowTerminal: true, allowNetwork: true }),
        });
        const events = await response.text();
        expect(response.status).toBe(200);
        expect(events).toContain('Tool-enabled chat request failed (HTTP 429: the provider rate limit was reached)');
        expect(events).not.toContain('UPSTREAM_PRIVATE_RATE_LIMIT_BODY');
      });
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    }
  });

  it('does not expose arbitrary upstream response bodies in model-discovery errors', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'UPSTREAM_PRIVATE_TOKEN_DO_NOT_ECHO' } }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    try {
      await withServer(app, async baseUrl => {
        const createdResponse = await fetch(`${baseUrl}/api/providers`, {
          method: 'POST', headers: headers(session, true),
          body: JSON.stringify(createProviderPayload(`http://127.0.0.1:${upstreamPort}/v1`)),
        });
        const { id } = await createdResponse.json() as { id: string };
        const modelsResponse = await fetch(`${baseUrl}/api/providers/${id}/models`, { headers: headers(session) });
        const result = await modelsResponse.json() as { message: string };
        expect(modelsResponse.status).toBe(502);
        expect(result.message).toContain('HTTP 401');
        expect(result.message).toContain('authentication was rejected');
        expect(result.message).not.toContain('UPSTREAM_PRIVATE_TOKEN_DO_NOT_ECHO');
      });
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    }
  });
});

describe('Incognito session ownership', () => {
  let app: ReturnType<typeof createApp>;
  let owner: TestSession;
  let other: TestSession;

  beforeEach(() => {
    app = createApp();
    owner = createSession();
    other = createSession();
  });

  it('limits temporary transcript access to its authenticated owner', async () => {
    await withServer(app, async baseUrl => {
      const startResponse = await fetch(`${baseUrl}/api/incognito/start`, { method: 'POST', headers: headers(owner, true), body: '{}' });
      expect(startResponse.status).toBe(200);
      const { sessionId } = await startResponse.json() as { sessionId: string };

      const crossOwner = await fetch(`${baseUrl}/api/incognito/${sessionId}`, { headers: headers(other) });
      expect(crossOwner.status).toBe(404);

      const saveResponse = await fetch(`${baseUrl}/api/incognito/${sessionId}/message`, {
        method: 'POST', headers: headers(owner, true), body: JSON.stringify({ role: 'user', content: 'temporary only' }),
      });
      expect(saveResponse.status).toBe(200);
      const readResponse = await fetch(`${baseUrl}/api/incognito/${sessionId}`, { headers: headers(owner) });
      const result = await readResponse.json() as { messages: { content: string }[] };
      expect(result.messages.map(message => message.content)).toEqual(['temporary only']);

      const otherCount = await fetch(`${baseUrl}/api/incognito/count`, { headers: headers(other) });
      expect(await otherCount.json()).toMatchObject({ activeSessions: 0 });
    });
  });
});

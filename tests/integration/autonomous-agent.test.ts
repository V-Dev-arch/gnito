import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type AddressInfo } from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gnito-agent-test-'));
const DOCKER_BIN = path.join(TEST_DIR, 'docker-not-installed');
process.env.GNITO_DATA_DIR = TEST_DIR;
process.env.GNITO_DOCKER_BIN = DOCKER_BIN;
process.env.GNITO_MASTER_KEY = randomUUID().replace(/-/g, '').repeat(2).slice(0, 64);

const { getDb, closeDb } = await import('../../src/server/db/index.js');
const { createApp } = await import('../../src/server/api/app.js');
const { createSession } = await import('../../src/server/security/auth.js');
const nativeFetch = globalThis.fetch.bind(globalThis);
const db = getDb();
const app = createApp();

let apiServer: any;
let baseUrl = '';
let openAiServer: any;
let openAiUrl = '';
const openAiRequests: any[] = [];
let manusCalls: string[] = [];

type TestSession = { token: string; csrf: string };
const session: TestSession = createSession();
const apiHeaders = (json = false): Record<string, string> => ({
  'X-Gnito-Session': session.token,
  'X-Gnito-CSRF': session.csrf,
  ...(json ? { 'Content-Type': 'application/json' } : {}),
});

beforeAll(async () => {
  apiServer = await new Promise<any>(resolve => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  baseUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
  const chatId = 'autonomous-agent-chat';
  db.prepare('INSERT INTO chats (id, project_id, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(chatId, null, 'Agent test', 'active', Date.now(), Date.now());

  openAiServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    openAiRequests.push(body);
    if (Array.isArray(body.messages) && body.messages.some((message: any) => message.role === 'user' && message.content === 'Incremental stream test')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Visible immediately.' } }] })}\n\n`);
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ' Final streamed text.' } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      }, 120);
      return;
    }
    if (Array.isArray(body.messages) && !body.messages.some((message: any) => message.role === 'tool') && body.messages.some((message: any) => message.role === 'user' && message.content === 'Preserve reasoning metadata')) {
      expect(body.stream).toBe(false);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: {
        role: 'assistant', content: null, reasoning_content: 'provider-private-reasoning-state',
        tool_calls: [{ id: 'tool-call-terminal_run', type: 'function', function: { name: 'terminal_run', arguments: JSON.stringify({ command: 'pwd' }) } }],
      } }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url?.includes('/images/generations')) {
      res.end(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/OQAAAABJRU5ErkJggg==' }] }));
      return;
    }
    if (!body.messages.some((message: any) => message.role === 'tool')) {
      const imageTool = body.tools?.some((tool: any) => tool.function?.name === 'generate_image');
      if (imageTool) expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'generate_image' } });
      else expect(body.tool_choice).toBe('auto');
      const tool = imageTool ? 'generate_image' : 'terminal_run';
      expect(body.tools?.some((entry: any) => entry.function?.name === tool)).toBe(true);
      const properties = body.tools.find((entry: any) => entry.function?.name === tool).function.parameters.properties;
      if (imageTool) expect(Object.keys(properties)).toEqual(['prompt', 'model', 'size']);
      else expect(Object.keys(properties)).toEqual(['command']);
      const args = imageTool ? { prompt: 'A test image', model: 'gpt-image-1', size: '1024x1024' } : { command: 'pwd && ls -la' };
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `tool-call-${tool}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } }] }));
    } else {
      const toolMessage = body.messages.find((message: any) => message.role === 'tool');
      expect(toolMessage).toBeTruthy();
      const imageTool = toolMessage.tool_call_id === 'tool-call-generate_image';
      if (imageTool) expect(toolMessage.content).toContain('/api/media/');
      else expect(toolMessage.tool_call_id).toBe('tool-call-terminal_run');
      const finalText = imageTool ? JSON.parse(toolMessage.content).output.markdown : 'The sandbox reported its Docker runtime status.';
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: finalText } }] }));
    }
  });
  await new Promise<void>(resolve => openAiServer.listen(0, '127.0.0.1', resolve));
  openAiUrl = `http://127.0.0.1:${(openAiServer.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  for (const server of [openAiServer, apiServer]) {
    if (!server) continue;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.GNITO_DATA_DIR;
  delete process.env.GNITO_DOCKER_BIN;
  delete process.env.GNITO_MASTER_KEY;
});

async function createProvider(payload: Record<string, unknown>): Promise<string> {
  const response = await nativeFetch(`${baseUrl}/api/providers`, { method: 'POST', headers: apiHeaders(true), body: JSON.stringify(payload) });
  expect(response.status).toBe(201);
  return (await response.json() as { id: string }).id;
}

async function sendChat(providerId: string, payload: Record<string, unknown>) {
  return nativeFetch(`${baseUrl}/api/providers/${providerId}/chat`, {
    method: 'POST', headers: apiHeaders(true), body: JSON.stringify(payload),
  });
}

describe('autonomous terminal tool loop', () => {
  it('streams ordinary assistant text when terminal tools are disabled', async () => {
    const providerId = await createProvider({ kind: 'custom', label: 'Mock streaming provider', baseUrl: openAiUrl, enabled: true });
    const response = await sendChat(providerId, {
      model: 'mock-model', allowTerminal: false, allowNetwork: false,
      messages: [{ role: 'user', content: 'Incremental stream test' }],
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('Visible immediately.');
    let rest = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += new TextDecoder().decode(chunk.value);
    }
    expect(rest).toContain('Final streamed text.');
    expect(rest).toContain('event: end');
  });

  it('preserves provider-specific assistant metadata on tool calls for the next provider turn', async () => {
    const providerId = await createProvider({ kind: 'custom', label: 'Mock metadata provider', baseUrl: openAiUrl, enabled: true });
    const requestStart = openAiRequests.length;
    const response = await sendChat(providerId, {
      model: 'mock-model', chatId: 'autonomous-agent-chat', allowTerminal: true, allowNetwork: false,
      messages: [{ role: 'user', content: 'Preserve reasoning metadata' }],
    });
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('event: tool-start');
    expect(stream).toContain('event: tool-end');
    expect(stream).toContain('The sandbox reported its Docker runtime status.');
    const followup = openAiRequests.slice(requestStart).find(body => body.messages.some((message: any) => message.role === 'tool'));
    const assistantCall = followup.messages.find((message: any) => message.role === 'assistant' && message.tool_calls);
    expect(assistantCall.tool_calls[0]).toMatchObject({ id: 'tool-call-terminal_run', function: { name: 'terminal_run', arguments: JSON.stringify({ command: 'pwd' }) } });
    expect(assistantCall.reasoning_content).toBe('provider-private-reasoning-state');
    expect(followup.stream).toBe(false);
  });

  it('runs the model-directed tool only after per-message permission and records its exact command/result', async () => {
    const providerId = await createProvider({ kind: 'custom', label: 'Mock tool provider', baseUrl: openAiUrl, enabled: true });
    const response = await sendChat(providerId, {
      model: 'mock-model', chatId: 'autonomous-agent-chat', allowTerminal: true, allowNetwork: false,
      messages: [{ role: 'user', content: 'Inspect the workspace.' }],
    });
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('event: tool-start');
    expect(stream).toContain('event: tool-end');
    expect(stream).toContain('The sandbox reported its Docker runtime status.');
    expect(stream).not.toContain('Thinking…');
    const run = db.prepare('SELECT tool, input, status, context FROM tool_runs WHERE context=? ORDER BY started_at DESC LIMIT 1').get('autonomous-agent-chat') as any;
    expect(run.tool).toBe('terminal_run');
    expect(JSON.parse(run.input)).toMatchObject({ command: 'pwd && ls -la', timeoutMs: 180_000, networkAccess: false });
    expect(run.context).toBe('autonomous-agent-chat');
    expect(['failed', 'succeeded']).toContain(run.status);
  });

  it('rejects network permission unless terminal permission is also explicitly granted', async () => {
    const providerId = await createProvider({ kind: 'custom', label: 'Validation provider', baseUrl: openAiUrl, enabled: true });
    const response = await sendChat(providerId, {
      model: 'mock-model', allowTerminal: false, allowNetwork: true,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: 'Enable terminal access before granting terminal network access.' });
  });

  it('exposes image generation only when opted in and emits a local media event with a final Markdown link', async () => {
    const providerId = await createProvider({ kind: 'openai-compatible', label: 'Mock Images provider', baseUrl: openAiUrl, apiKey: 'test-openai-key', enabled: true });
    const response = await sendChat(providerId, {
      model: 'mock-model', chatId: 'autonomous-agent-chat', allowTerminal: false, allowImageTools: true,
      messages: [{ role: 'user', content: 'Create a test image.' }],
    });
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('event: media');
    expect(stream).toContain('/api/media/');
    expect(stream).toMatch(/!\[Generated image\]\(\/api\/media\/[0-9a-f-]+\)/i);
    const mediaPath = stream.match(/\/api\/media\/[0-9a-f-]+/i)?.[0];
    expect(mediaPath).toBeTruthy();
    const preview = await nativeFetch(`${baseUrl}${mediaPath}`, { headers: { 'X-Gnito-Session': session.token, 'X-Gnito-CSRF': session.csrf } });
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toContain('image/png');
    const blocked = await nativeFetch(`${baseUrl}${mediaPath}`);
    expect(blocked.status).toBe(401);
  });

  it('routes Manus through the documented async task API and returns real status/final task text', async () => {
    const providerId = await createProvider({
      kind: 'manus-agent', label: 'Manus', baseUrl: 'https://api.manus.ai', apiKey: 'test-manus-key', enabled: true,
    });
    const originalFetch = globalThis.fetch;
    manusCalls = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith('https://api.manus.ai/')) return originalFetch(input, init);
      manusCalls.push(url);
      expect(new Headers(init?.headers).get('x-manus-api-key')).toBe('test-manus-key');
      if (url.endsWith('/v2/task.create')) return new Response(JSON.stringify({ task_id: 'test-task-id', task_url: 'https://manus.im/app/test-task-id' }), { status: 200 });
      if (url.includes('/v2/task.detail')) return new Response(JSON.stringify({ task: { id: 'test-task-id', status: 'stopped', has_running_background_jobs: false, task_url: 'https://manus.im/app/test-task-id' } }), { status: 200 });
      if (url.includes('/v2/task.listMessages')) return new Response(JSON.stringify({ messages: [{ type: 'assistant_message', assistant_message: { content: 'Manus task result.', delivery_kind: 'final' } }] }), { status: 200 });
      throw new Error(`Unexpected Manus URL ${url}`);
    };
    try {
      const response = await sendChat(providerId, { model: 'standard', messages: [{ role: 'user', content: 'Do a remote task.' }] });
      expect(response.status).toBe(200);
      const stream = await response.text();
      expect(stream).toContain('Manus status · stopped');
      expect(stream).toContain('Manus task result.');
      expect(stream).toContain('[Open Manus task](https://manus.im/app/test-task-id)');
      expect(manusCalls.some(url => url.endsWith('/v2/task.create'))).toBe(true);
      expect(manusCalls.some(url => url.includes('/v2/task.detail'))).toBe(true);
      expect(manusCalls.some(url => url.includes('/v2/task.listMessages'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

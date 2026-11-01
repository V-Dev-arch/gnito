/**
 * Gnito — Provider adapter layer.
 *
 * A "provider" is a BYOK model/API endpoint (OpenAI-compatible, Anthropic-compatible,
 * or a custom OpenAI-compatible endpoint like Ollama/LM Studio/vLLM).
 *
 * SECURITY:
 *  - API keys are read from the secrets vault (server-side only), never
 *    logged, never sent to the client, never embedded in URLs.
 *  - Upstream response bodies are never forwarded; the UI receives safe status/network summaries.
 *  - We support streaming with cancellation.
 *
 * Implementation uses fetch() (Node 20 has native fetch). For
 * Anthropic-compatible we use a distinct request shape.
 */
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ModelInfo } from '../../shared/types.js';
import { getDb } from '../db/index.js';
import { getProviderSecret, setProviderSecret, deleteProviderSecret } from '../security/vault.js';
import { executeAgentTerminal, executeGitHubTool } from './tools.js';
import { storeGeneratedPng } from './media.js';

const db = getDb();
const MANUS_API_ROOT = 'https://api.manus.ai';
const MANUS_PROFILES: ModelInfo[] = [
  { id: 'lite', label: 'Manus Lite', capabilities: ['text'] },
  { id: 'standard', label: 'Manus Standard', capabilities: ['text'] },
  { id: 'max', label: 'Manus Max', capabilities: ['text'] },
];

// -------------------------------------------------------------- validation

const ProviderBaseUrl = z.string().url().max(500).refine(value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}, 'Use an HTTP(S) API URL without embedded credentials, query parameters, or a fragment.');

const CreateProviderInput = z.object({
  kind: z.enum(['openai-compatible', 'anthropic-compatible', 'manus-agent', 'custom']),
  label: z.string().min(1).max(100),
  baseUrl: ProviderBaseUrl,
  apiKey: z.string().min(1).max(500).optional(),
  customHeaders: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
});

const UpdateProviderInput = z.object({
  label: z.string().min(1).max(100).optional(),
  baseUrl: ProviderBaseUrl.optional(),
  apiKey: z.string().min(1).max(500).optional(),
  customHeaders: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});

// ---------------------------------------------------------------- routes

export function registerProviderRoutes(app: any): void {
  // List providers — no API keys, just metadata.
  app.get('/api/providers', (req: Request, res: Response) => {
    const rows = db.prepare(`SELECT * FROM providers ORDER BY created_at`).all() as any[];
    const out = rows.map(r => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      baseUrl: r.base_url,
      enabled: !!r.enabled,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      hasKey: !!getProviderSecret(r.id),
    }));
    res.json(out);
  });

  // Create a provider.
  app.post('/api/providers', (req: Request, res: Response) => {
    const parsed = CreateProviderInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', issues: parsed.error.issues });
      return;
    }
    const { kind, label, baseUrl, apiKey, customHeaders, enabled } = parsed.data;
    if (kind === 'manus-agent' && baseUrl.replace(/\/+$/, '') !== MANUS_API_ROOT) {
      res.status(400).json({ error: 'validation', message: 'Manus must use its official API root.' });
      return;
    }
    const id = randomUUID();
    const now = Date.now();
    if (apiKey) setProviderSecret(id, apiKey);
    db.prepare(`
      INSERT INTO providers (id, kind, label, base_url, enabled, custom_headers, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(id, kind, label, baseUrl, enabled ? 1 : 0, JSON.stringify(customHeaders), now, now);
    res.status(201).json({ id, ok: true });
  });

  // Update a provider (optional apiKey replacement).
  app.patch('/api/providers/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as any;
    if (!existing) { res.status(404).json({ error: 'not-found' }); return; }
    const parsed = UpdateProviderInput.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation', issues: parsed.error.issues }); return; }
    const p = parsed.data;
    if (existing.kind === 'manus-agent' && p.baseUrl && p.baseUrl.replace(/\/+$/, '') !== MANUS_API_ROOT) {
      res.status(400).json({ error: 'validation', message: 'Manus must use its official API root.' });
      return;
    }
    if (p.apiKey) setProviderSecret(id, p.apiKey);
    db.prepare(`
      UPDATE providers SET
        label = ?, base_url = ?, enabled = ?, custom_headers = ?, updated_at = ?
      WHERE id = ?
    `).run(
      p.label ?? existing.label,
      p.baseUrl ?? existing.base_url,
      p.enabled === undefined ? existing.enabled : (p.enabled ? 1 : 0),
      JSON.stringify(p.customHeaders ?? JSON.parse(existing.custom_headers || '{}')),
      Date.now(),
      id,
    );
    res.json({ ok: true });
  });

  // Delete a provider + its secret.
  app.delete('/api/providers/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    deleteProviderSecret(id);
    res.json({ ok: true });
  });

  // Fetch the live model list for the selected provider.
  app.get('/api/providers/:id/models', async (req: Request, res: Response) => {
    const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: 'not-found', message: 'Provider not found.' }); return; }
    if (!row.enabled) { res.status(409).json({ error: 'provider-disabled', message: 'Enable this provider before loading its models.' }); return; }
    const apiKey = getProviderSecret(row.id) || '';
    if (!apiKey && row.kind !== 'custom') {
      res.status(400).json({ error: 'missing-key', message: 'Add an API key for this provider before loading models.' });
      return;
    }
    try {
      res.json({ models: await listModelsForProvider(row, apiKey) });
    } catch (e: any) {
      res.status(502).json({ error: 'model-list-failed', message: safeProviderError(e, 'Model discovery') });
    }
  });

  // Test connection — performs a real request and returns safe diagnostics without echoing secrets.
  app.post('/api/providers/:id/test', async (req: Request, res: Response) => {
    const { id } = req.params;
    const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as any;
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    const apiKey = getProviderSecret(id) || '';
    if (!apiKey && row.kind !== 'custom') {
      res.json({ ok: false, error: 'No API key saved for this provider.' });
      return;
    }
    const startedAt = Date.now();
    try {
      const models = await listModelsForProvider(row, apiKey);
      if (row.kind === 'manus-agent') await verifyManusApiKey(apiKey);
      res.json({
        ok: true,
        latencyMs: Date.now() - startedAt,
        models,
      });
    } catch (e: any) {
      res.json({
        ok: false,
        error: safeProviderError(e, 'Connection test'),
      });
    }
  });

  // Stream a chat completion.
  app.post('/api/providers/:id/chat', async (req: Request, res: Response) => {
    const { id } = req.params;
    const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as any;
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    if (!row.enabled) { res.status(409).json({ error: 'provider-disabled', message: 'Enable this provider before sending a chat request.' }); return; }

    const ChatRequest = z.object({
      model: z.string().min(1).max(200),
      messages: z.array(z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: z.union([
          z.string().max(200_000),
          z.array(z.union([
            z.object({ type: z.literal('text'), text: z.string().max(200_000) }),
            z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string().max(7_000_000) }) }),
          ])).max(20),
        ]),
      })).min(1).max(200),
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().positive().max(128_000).optional(),
      stream: z.boolean().default(true),
      allowTerminal: z.boolean().default(false),
      allowNetwork: z.boolean().default(false),
      allowImageTools: z.boolean().default(false),
      allowGitHubTools: z.boolean().default(false),
      chatId: z.string().min(1).max(200).optional(),
    });
    const parsed = ChatRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', issues: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    const imageParts = body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []);
    if (imageParts.some(part => !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(part.image_url.url))) {
      res.status(400).json({ error: 'validation', message: 'Image attachments must be local PNG, JPEG, WebP or GIF files within the attachment size limit.' });
      return;
    }
    if (row.kind === 'manus-agent' && imageParts.length) {
      res.status(400).json({ error: 'unsupported-attachments', message: 'This provider path does not forward image attachments. Choose an OpenAI- or Anthropic-compatible vision model.' });
      return;
    }
    if (body.allowImageTools && ['anthropic-compatible', 'manus-agent'].includes(row.kind)) {
      res.status(400).json({ error: 'unsupported-image-tools', message: 'AI image generation requires an OpenAI-compatible provider that exposes the Images API.' });
      return;
    }
    if (body.allowNetwork && !body.allowTerminal) {
      res.status(400).json({ error: 'validation', message: 'Enable terminal access before granting terminal network access.' });
      return;
    }
    if (body.allowTerminal && row.kind === 'manus-agent') {
      res.status(400).json({ error: 'remote-provider', message: 'Manus runs remotely and cannot access Gnito’s local Docker sandbox. Select an OpenAI-compatible or Anthropic provider for local terminal tools.' });
      return;
    }
    if (body.allowTerminal && (!body.chatId || !db.prepare('SELECT id FROM chats WHERE id=?').get(body.chatId))) {
      res.status(400).json({ error: 'chat-required', message: 'Save this conversation before enabling terminal tools.' });
      return;
    }
    const apiKey = getProviderSecret(id) || '';
    if (!apiKey && row.kind !== 'custom') {
      res.status(400).json({ error: 'missing-key', message: 'Add an API key for this provider before sending a chat request.' });
      return;
    }

    // SSE streaming response.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let abortController: AbortController | null = null;
    let manusTaskId: string | null = null;
    res.on('close', () => {
      if (!res.writableEnded && abortController) {
        abortController.abort();
        if (row.kind === 'manus-agent' && manusTaskId) void stopManusTask(apiKey, manusTaskId);
      }
    });

    try {
      abortController = new AbortController();
      if (row.kind === 'manus-agent') {
        const result = await runManusTask({
          apiKey,
          profile: body.model,
          messages: body.messages.map(message => ({ role: message.role, content: providerText(message.content) })),
          signal: abortController.signal,
          onTaskCreated: taskId => { manusTaskId = taskId; send('activity', { message: `Manus task created · ${taskId}` }); },
          onStatus: status => send('activity', { message: `Manus status · ${status}` }),
        });
        if (result.taskUrl) send('activity', { message: `Manus task URL · ${result.taskUrl}` });
        const resultText = result.taskUrl && !result.text.includes(result.taskUrl)
          ? `${result.text}\n\n[Open Manus task](${result.taskUrl})`
          : result.text;
        send('chunk', { delta: resultText });
        send('end', { status: result.status });
        res.end();
        return;
      }
      const url = buildChatUrl(row);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(row.kind === 'anthropic-compatible'
          ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
          : (apiKey ? { Authorization: `Bearer ${apiKey}` } : {})),
        ...JSON.parse(row.custom_headers || '{}'),
      };

      if (body.allowTerminal || body.allowImageTools || body.allowGitHubTools) {
        const text = row.kind === 'anthropic-compatible'
          ? await runAnthropicAgent({ url, headers, body, signal: abortController.signal, chatId: body.chatId!, allowNetwork: body.allowNetwork, allowGitHubTools: body.allowGitHubTools, send })
          : await runOpenAIAgent({ url, headers, body, signal: abortController.signal, chatId: body.chatId || '', allowNetwork: body.allowNetwork, allowTerminal: body.allowTerminal, allowImageTools: body.allowImageTools, allowGitHubTools: body.allowGitHubTools, forceImageGeneration: body.allowImageTools && hasExplicitImageRequest(body.messages), send, imageUrls: imageEndpointCandidates(row.base_url) });
        if (text) send('chunk', { delta: text });
        send('end', {});
        res.end();
        return;
      }

      const anthropicSystemPrompt = providerText(body.messages.find(message => message.role === 'system')?.content);
      const providerRequestBody = row.kind === 'anthropic-compatible'
        ? {
            model: body.model,
            messages: body.messages.filter(message => message.role !== 'system').map(message => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: toAnthropicContent(message.content) })),
            ...(anthropicSystemPrompt ? { system: anthropicSystemPrompt } : {}),
            stream: body.stream,
            temperature: body.temperature,
            max_tokens: body.maxTokens ?? 4096,
          }
        : {
            model: body.model,
            messages: body.messages,
            stream: body.stream,
            temperature: body.temperature,
            max_tokens: body.maxTokens,
          };
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(providerRequestBody),
        signal: abortController.signal,
      });

      if (!resp.ok) {
        void resp.body?.cancel().catch(() => {});
        send('error', { message: safeProviderStatusError(resp.status, imageParts.length ? 'Vision chat request' : 'Chat request') });
        send('end', {});
        res.end();
        return;
      }

      if (!body.stream || !resp.body) {
        // Non-streaming: parse full JSON and emit one chunk.
        const json = await resp.json().catch(() => null);
        const text = extractAssistantText(json, row.kind);
        send('chunk', { delta: text });
        send('end', {});
        res.end();
        return;
      }

      // Streaming — parse SSE lines.
      const reader = (resp.body as any).getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let closed = false;
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) { closed = true; break; }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data:')) {
            const dataStr = line.slice(5).trim();
            if (dataStr === '[DONE]') { closed = true; break; }
            try {
              const chunk = JSON.parse(dataStr);
              const delta = extractStreamDelta(chunk, row.kind);
              if (delta) send('chunk', { delta });
            } catch { /* partial JSON, ignore */ }
          }
        }
      }
      send('end', {});
      res.end();
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        send('end', { cancelled: true });
      } else {
        send('error', { message: safeProviderError(e, 'Chat request') });
        send('end', {});
      }
      res.end();
    }
  });
}

// ---------------------------------------------------------------- helpers

function buildChatUrl(row: any): string {
  const suffix = row.kind === 'anthropic-compatible' ? '/v1/messages' : '/chat/completions';
  return appendEndpoint(row.base_url, suffix);
}
function appendEndpoint(baseUrl: string, endpoint: string): string {
  const base = normalizeOpenAIBaseUrl(baseUrl);
  const path = endpoint.startsWith('/v1/') && /\/v1$/i.test(base) ? endpoint.slice(3) : endpoint;
  return `${base}${path}`;
}
function normalizeOpenAIBaseUrl(baseUrl: string): string {
  let base = String(baseUrl || '').replace(/\/+$/, '');
  base = base.replace(/\/(?:chat\/completions|responses|images\/generations|models)$/i, '');
  try {
    const url = new URL(base);
    if (url.hostname.toLowerCase() === 'api.openai.com' && url.pathname === '') base = `${base}/v1`;
  } catch { /* Provider URL validation reports malformed URLs before this point. */ }
  return base;
}
function imageEndpointCandidates(baseUrl: string): string[] {
  const candidates = [appendEndpoint(baseUrl, '/images/generations')];
  try {
    const normalized = new URL(normalizeOpenAIBaseUrl(baseUrl));
    if (!/(^|\/)v1(?:\/|$)/i.test(normalized.pathname)) {
      const withV1 = new URL(normalized.toString());
      withV1.pathname = `${withV1.pathname.replace(/\/+$/, '')}/v1`;
      candidates.push(appendEndpoint(withV1.toString(), '/images/generations'));
    }
  } catch { /* Provider URL validation reports malformed URLs before this point. */ }
  return [...new Set(candidates)];
}

function extractAssistantText(json: any, kind: string): string {
  if (kind === 'anthropic-compatible') {
    return json?.content?.filter((c: any) => c?.type === 'text').map((c: any) => c?.text).join('') || '';
  }
  return json?.choices?.[0]?.message?.content || '';
}

function extractStreamDelta(chunk: any, kind: string): string | null {
  if (kind === 'anthropic-compatible') {
    return chunk?.delta?.text ?? null;
  }
  return chunk?.choices?.[0]?.delta?.content ?? null;
}

async function verifyManusApiKey(apiKey: string): Promise<void> {
  await manusJson(`${MANUS_API_ROOT}/v2/user.me`, apiKey, { method: 'GET' }, AbortSignal.timeout(10_000));
}

async function runManusTask(options: {
  apiKey: string;
  profile: string;
  messages: { role: string; content: string }[];
  signal: AbortSignal;
  onTaskCreated: (taskId: string) => void;
  onStatus: (status: string) => void;
}): Promise<{ text: string; status: string; taskUrl?: string }> {
  const profile = ['lite', 'standard', 'max'].includes(options.profile) ? options.profile : 'standard';
  const transcript = options.messages.map(message => `${message.role.toUpperCase()}\n${message.content}`).join('\n\n').slice(-14_000);
  const created = await manusJson(`${MANUS_API_ROOT}/v2/task.create`, options.apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: { content: [{ type: 'text', text: transcript, visibility: 'visible' }] },
      agent_profile: profile,
      share_visibility: 'private',
    }),
  }, options.signal);
  const taskId = String(created?.task_id || '');
  if (!taskId) throw new Error('Manus did not return a task ID.');
  options.onTaskCreated(taskId);
  const rawTaskUrl = typeof created?.task_url === 'string' ? created.task_url : '';
  const taskUrl = safeManusTaskUrl(rawTaskUrl);
  const deadline = Date.now() + 180_000;
  let previousStatus = '';

  while (Date.now() < deadline) {
    await abortableDelay(2_000, options.signal);
    const detail = await manusJson(`${MANUS_API_ROOT}/v2/task.detail?task_id=${encodeURIComponent(taskId)}`, options.apiKey, { method: 'GET' }, options.signal);
    const task = detail?.task || {};
    const status = String(task.status || 'unknown');
    if (status !== previousStatus) { previousStatus = status; options.onStatus(status); }
    if (status === 'error') {
      const messages = await getManusTaskMessages(taskId, options.apiKey, options.signal);
      const errorText = extractManusTaskText(messages, true);
      throw new Error(errorText ? `Manus task failed: ${errorText.slice(0, 600)}` : 'Manus task failed.');
    }
    if (status === 'waiting') {
      const messages = await getManusTaskMessages(taskId, options.apiKey, options.signal);
      const text = extractManusTaskText(messages, false) || 'Manus is waiting for input in its remote task.';
      return { text: `${text}\n\nManus is waiting for follow-up in its remote task${taskUrl ? `: ${taskUrl}` : ''}.`, status, taskUrl };
    }
    if (status === 'stopped' && task.has_running_background_jobs === false) {
      const messages = await getManusTaskMessages(taskId, options.apiKey, options.signal);
      return { text: extractManusTaskText(messages, false) || 'Manus task completed without a text response.', status, taskUrl };
    }
  }

  options.onStatus('still running (Gnito polling deadline reached)');
  return {
    text: `Manus is still working after Gnito’s 3-minute wait. The remote task continues${taskUrl ? `; open it here: ${taskUrl}` : ` (task ${taskId})`}.`,
    status: 'running', taskUrl,
  };
}

async function manusJson(url: string, apiKey: string, init: RequestInit, signal: AbortSignal): Promise<any> {
  const response = await fetch(url, {
    ...init,
    headers: { 'x-manus-api-key': apiKey, ...((init.headers || {}) as Record<string, string>) },
    signal,
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new ProviderHttpError(response.status, 'Manus API request');
  }
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error('Manus API response exceeded the 1 MB limit.');
  try { return JSON.parse(text); }
  catch { throw new Error('Manus API returned invalid JSON.'); }
}

async function getManusTaskMessages(taskId: string, apiKey: string, signal: AbortSignal): Promise<any[]> {
  const query = new URLSearchParams({ task_id: taskId, order: 'desc', limit: '50' });
  const response = await manusJson(`${MANUS_API_ROOT}/v2/task.listMessages?${query}`, apiKey, { method: 'GET' }, signal);
  return Array.isArray(response?.messages) ? response.messages : [];
}

function extractManusTaskText(messages: any[], errorsOnly: boolean): string {
  const selected = messages.filter(message => errorsOnly
    ? message?.type === 'error_message'
    : message?.type === 'assistant_message');
  const finalMessages = errorsOnly ? selected : selected.filter(message => message?.assistant_message?.delivery_kind !== 'progress');
  const message = finalMessages[0] || selected[0];
  const payload = errorsOnly ? message?.error_message?.content : message?.assistant_message?.content;
  if (typeof payload === 'string') return payload.trim().slice(0, 12_000);
  if (Array.isArray(payload)) return payload.map(part => typeof part?.text === 'string' ? part.text : '').join('\n').trim().slice(0, 12_000);
  return '';
}

function safeManusTaskUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && (url.hostname === 'manus.im' || url.hostname.endsWith('.manus.im')) ? url.toString() : undefined;
  } catch { return undefined; }
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('Aborted', 'AbortError')); }
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function stopManusTask(apiKey: string, taskId: string): Promise<void> {
  try {
    await fetch(`${MANUS_API_ROOT}/v2/task.stop`, {
      method: 'POST', headers: { 'x-manus-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId }), signal: AbortSignal.timeout(5_000),
    });
  } catch { /* the user has already stopped the Gnito stream; do not leak secrets or block */ }
}

type AgentChatBody = { model: string; messages: { role: string; content: any }[]; temperature?: number; maxTokens?: number };
type AgentSend = (event: string, data: unknown) => void;

const TERMINAL_TOOL = {
  type: 'function',
  function: {
    name: 'terminal_run',
    description: 'Run a command in the user-approved Gnito Docker workspace. Never use for destructive actions without first explaining them. Network is only available if the user explicitly enabled it for this message.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Shell command to run in /workspace.' } },
      required: ['command'],
    },
  },
};

const ANTHROPIC_TERMINAL_TOOL = {
  name: 'terminal_run',
  description: 'Run a command in the user-approved Gnito Docker workspace. Never use for destructive actions without first explaining them. Network is only available if the user explicitly enabled it for this message.',
  input_schema: {
    type: 'object',
    properties: { command: { type: 'string', description: 'Shell command to run in /workspace.' } },
    required: ['command'],
  },
};

const ANTHROPIC_GITHUB_TOOL = {
  name: 'github_api',
  description: 'Use the connected GitHub PAT through the GitHub REST API. GitHub enforces the token scopes and fine-grained repository permissions; never expose the token.',
  input_schema: {
    type: 'object',
    properties: {
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      path: { type: 'string', description: 'Relative GitHub API path beginning with /.' },
      body: { type: 'object', description: 'JSON request body for POST, PUT, or PATCH.' },
    },
    required: ['path'],
  },
};

const TERMINAL_TOOL_POLICY = 'A local Docker terminal tool is available for this message because the user explicitly enabled it. Use it when commands materially help. Commands run in a dedicated container with only Gnito’s persistent workspace mounted; no host home, Docker socket, or server environment variables are mounted. Ask before destructive or irreversible operations. Never claim a command ran unless its tool result confirms it. The Network toggle is authoritative and Gnito applies it to every command; do not try to change or bypass it. For public GitHub repositories, prefer `git clone https://github.com/OWNER/REPO.git` rather than `gh repo clone`, which may require a CLI login. When cloning or downloading, set `timeoutMs` to at least 180000. If Network is off, explain that it must be enabled before cloning. If a network-enabled clone fails, test `curl -I https://github.com` and `git ls-remote https://github.com/OWNER/REPO.git` and report the exact observed error; do not claim the repo cloned unless the command confirms it. When creating images/videos in /workspace, return a Markdown link to /api/terminal/media?path=<URL-encoded absolute /workspace path> for safe preview and download.';

const IMAGE_TOOL = {
  type: 'function',
  function: {
    name: 'generate_image',
    description: 'Generate one image using the configured provider Images API. Use when the user asks to create, draw, or generate an image. Return the resulting image using the provided Markdown image URL so Gnito can render it and offer a download button.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed visual description of the requested image.' },
        model: { type: 'string', description: 'Optional image model exposed by this provider; defaults to gpt-image-1.' },
        size: { type: 'string', description: 'Optional size: 1024x1024, 1536x1024, or 1024x1536.' },
      },
      required: ['prompt'],
    },
  },
};

const IMAGE_TOOL_POLICY = 'An image-generation tool is available because the user explicitly enabled Image tools. Use it only when an image is requested. After a successful image generation, include the exact returned Markdown image link in your final answer; Gnito renders it with a download action. The configured provider must support the OpenAI Images API. The request may incur provider charges.';
const GITHUB_TOOL = {
  type: 'function',
  function: {
    name: 'github_api',
    description: 'Use the connected GitHub PAT through the GitHub REST API. The token’s scopes and fine-grained repository permissions are enforced by GitHub; never ask for or expose the token. Use relative API paths such as /user, /user/repos, /repos/OWNER/REPO/issues, /repos/OWNER/REPO/contents/PATH, or /repos/OWNER/REPO/pulls.',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method.' },
        path: { type: 'string', description: 'Relative GitHub API path beginning with /. Never use a full URL.' },
        body: { type: 'object', description: 'JSON request body for POST, PUT, or PATCH.' },
      },
      required: ['path'],
    },
  },
};
const GITHUB_TOOL_POLICY = 'A GitHub plugin is connected. Use github_api for GitHub work instead of asking the user to paste tokens or using terminal credentials. GitHub itself enforces the PAT scopes and fine-grained repository permissions. Explain write or destructive actions before making them, and never claim success unless the tool result confirms it.';
async function runOpenAIAgent(options: {
  url: string; headers: Record<string, string>; body: AgentChatBody; signal: AbortSignal;
  chatId: string; allowNetwork: boolean; allowTerminal: boolean; allowImageTools: boolean; allowGitHubTools: boolean; forceImageGeneration: boolean;
  imageUrls: string[]; send: AgentSend;
}): Promise<string> {
  const policies = [
    ...(options.allowTerminal ? [TERMINAL_TOOL_POLICY] : []),
    ...(options.allowImageTools ? [IMAGE_TOOL_POLICY] : []),
    ...(options.allowGitHubTools ? [GITHUB_TOOL_POLICY] : []),
  ];
  const messages: any[] = [...(policies.length ? [{ role: 'system', content: policies.join('\n\n') }] : []), ...options.body.messages];
  let toolCount = 0;
  let imageCount = 0;
  for (let round = 0; round < 10; round++) {
    let turn: { response: any; streamedText: string };
    try {
      turn = await postProviderChat(options.url, options.headers, {
        model: options.body.model,
        messages,
        // Keep tool turns non-streaming so the original assistant message (including provider-
        // specific fields such as reasoning_content required by some APIs on tool follow-up) is
        // preserved verbatim. Ordinary chat without tools still uses the streaming route below.
        stream: false,
        temperature: options.body.temperature,
        max_tokens: options.body.maxTokens,
        tools: [
          ...(options.allowTerminal ? [TERMINAL_TOOL] : []),
          ...(options.allowImageTools ? [IMAGE_TOOL] : []),
          ...(options.allowGitHubTools ? [GITHUB_TOOL] : []),
        ],
        tool_choice: round === 0 && options.forceImageGeneration
          ? { type: 'function', function: { name: 'generate_image' } }
          : 'auto',
      }, options.signal, delta => options.send('chunk', { delta }));
    } catch (error) {
      if (round === 0 && options.forceImageGeneration && options.allowImageTools) {
        options.send('activity', { message: 'The provider rejected tool chat; using the image tool directly…' });
        const prompt = providerText([...options.body.messages].reverse().find(message => message.role === 'user')?.content).trim();
        const fallback = await generateImage({ prompt, size: '1024x1024' }, options.imageUrls, options.headers, options.signal);
        if (fallback.output) {
          options.send('media', fallback.output);
          return fallback.output.markdown || '';
        }
        throw new Error(fallback.error || (error as Error)?.message || 'Image generation failed.');
      }
      throw error;
    }
    const { response, streamedText } = turn;
    const message = response?.choices?.[0]?.message;
    if (!message) throw new Error('Provider returned no assistant message for the tool-enabled request.');
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!calls.length) return streamedText ? '' : providerText(message.content);
    messages.push(message);
    for (const call of calls) {
      const callId = String(call.id || randomUUID());
      let result: any;
      try {
        const args = typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function?.arguments;
        if (call.function?.name === 'terminal_run' && options.allowTerminal) {
          if (toolCount >= 8) throw new Error('This chat turn reached the safe limit of 8 terminal commands.');
          toolCount++;
          result = await runAgentTerminal(args, options);
        } else if (call.function?.name === 'generate_image' && options.allowImageTools) {
          if (imageCount >= 2) throw new Error('This chat turn reached the safe limit of 2 generated images.');
          imageCount++;
          options.send('activity', { message: 'Generating an image with the selected provider…' });
          result = await generateImage(args, options.imageUrls, options.headers, options.signal);
          if (result.output) options.send('media', result.output);
          else options.send('activity', { message: `Image tool failed: ${result.error || 'the provider returned no image.'}` });
        } else if (call.function?.name === 'github_api' && options.allowGitHubTools) {
          result = await executeGitHubTool(args, options.signal);
        } else {
          throw new Error(`Unsupported or disabled tool requested: ${String(call.function?.name || 'unknown')}`);
        }
      } catch (error: any) {
        result = { error: error?.message || 'The requested tool call could not be run.' };
      }
      messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify(result).slice(0, 30_000) });
    }
  }
  throw new Error('Provider exceeded the 10-round terminal tool-call limit without a final response.');
}

async function readLimitedResponse(response: globalThis.Response, maxBytes: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length') || 0) > maxBytes) throw new Error('The provider image response exceeded the 20 MiB transfer limit.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The provider returned an empty image response.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('The provider image response exceeded the 20 MiB transfer limit.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
}

async function generateImage(input: unknown, urls: string[], headers: Record<string, string>, signal: AbortSignal): Promise<{ output?: any; error?: string }> {
  const schema = z.object({
    prompt: z.string().trim().min(1).max(2_000),
    model: z.string().trim().min(1).max(120).optional(),
    size: z.enum(['1024x1024', '1536x1024', '1024x1536']).default('1024x1024'),
  });
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: 'The image-generation request was invalid.' };
  const { prompt, size } = parsed.data;
  const requestedModel = parsed.data.model || '';
  const model = /(?:image|dall-e|flux|imagen|stable|diffusion)/i.test(requestedModel) ? requestedModel : 'gpt-image-1';
  try {
    let response: globalThis.Response | null = null;
    let lastStatus = 0;
    for (const url of urls) {
      response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, prompt, size, n: 1, ...(model.toLowerCase().startsWith('dall-e') ? { response_format: 'b64_json' } : {}) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      });
      lastStatus = response.status;
      if (response.ok || ![400, 404].includes(response.status) || url === urls[urls.length - 1]) break;
      void response.body?.cancel().catch(() => {});
    }
    if (!response) return { error: 'No image-generation endpoint is configured for this provider.' };
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return { error: safeProviderStatusError(lastStatus, 'Image generation') };
    }
    const maxResponseBytes = 28 * 1024 * 1024;
    if (Number(response.headers.get('content-length') || 0) > maxResponseBytes) {
      void response.body?.cancel().catch(() => {});
      return { error: 'The provider image response exceeded the 28 MiB transfer limit.' };
    }
    const reader = response.body?.getReader();
    if (!reader) return { error: 'The provider returned an empty image response.' };
    const chunks: Uint8Array[] = [];
    let responseBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        responseBytes += value.byteLength;
        if (responseBytes > maxResponseBytes) {
          await reader.cancel().catch(() => {});
          return { error: 'The provider image response exceeded the 28 MiB transfer limit.' };
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const text = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
    let json: any;
    try { json = JSON.parse(text); } catch { return { error: 'The provider returned invalid JSON for image generation.' }; }
    let encoded = json?.data?.[0]?.b64_json;
    const remoteUrl = json?.data?.[0]?.url;
    if (typeof encoded !== 'string' && typeof remoteUrl === 'string') {
      let parsedUrl: URL;
      try { parsedUrl = new URL(remoteUrl); }
      catch { return { error: 'The provider returned an invalid image URL.' }; }
      let providerOrigin = '';
      try { providerOrigin = new URL(urls[0]).origin; } catch { /* the request URL was already validated by the provider call */ }
      if (parsedUrl.protocol !== 'https:' && parsedUrl.origin !== providerOrigin) return { error: 'The provider returned an unsafe image URL.' };
      const imageResponse = await fetch(parsedUrl, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      });
      if (!imageResponse.ok) {
        void imageResponse.body?.cancel().catch(() => {});
        return { error: safeProviderStatusError(imageResponse.status, 'Image download') };
      }
      const imageBytes = await readLimitedResponse(imageResponse, 20 * 1024 * 1024);
      encoded = imageBytes.toString('base64');
    }
    if (typeof encoded !== 'string') return { error: 'The provider returned no image data. Select a provider/model that supports OpenAI Images API output.' };
    const stored = storeGeneratedPng(encoded);
    return { output: {
      kind: 'image',
      url: stored.url,
      downloadUrl: `${stored.url}?download=1`,
      prompt,
      markdown: `![Generated image](${stored.url})`,
    } };
  } catch (error: any) {
    return { error: safeProviderError(error, 'Image generation') };
  }
}

async function runAnthropicAgent(options: {
  url: string; headers: Record<string, string>; body: AgentChatBody; signal: AbortSignal;
  chatId: string; allowNetwork: boolean; allowGitHubTools: boolean; send: AgentSend;
}): Promise<string> {
  const system = [TERMINAL_TOOL_POLICY, ...(options.allowGitHubTools ? [GITHUB_TOOL_POLICY] : []), ...options.body.messages.filter(message => message.role === 'system').map(message => message.content)].join('\n\n');
  const messages: any[] = options.body.messages.filter(message => message.role !== 'system').map(message => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: toAnthropicContent(message.content) }));
  let toolCount = 0;
  for (let round = 0; round < 10; round++) {
    const { response, streamedText } = await postAnthropicChat(options.url, options.headers, {
      model: options.body.model,
      messages,
      system,
      max_tokens: options.body.maxTokens || 4096,
      temperature: options.body.temperature,
      tools: [ANTHROPIC_TERMINAL_TOOL, ...(options.allowGitHubTools ? [ANTHROPIC_GITHUB_TOOL] : [])],
      stream: false,
    }, options.signal, delta => options.send('chunk', { delta }));
    const blocks = Array.isArray(response?.content) ? response.content : [];
    const calls = blocks.filter((block: any) => block?.type === 'tool_use');
    if (!calls.length) return streamedText ? '' : blocks.filter((block: any) => block?.type === 'text').map((block: any) => String(block.text || '')).join('');
    messages.push({ role: 'assistant', content: blocks });
    const toolResults = [];
    for (const call of calls) {
      let result: any;
      try {
        if (call.name === 'github_api' && options.allowGitHubTools) {
          result = await executeGitHubTool(call.input, options.signal);
        } else {
          if (call.name !== 'terminal_run') throw new Error(`Unsupported tool requested: ${String(call.name || 'unknown')}`);
          if (toolCount >= 8) throw new Error('This chat turn reached the safe limit of 8 terminal commands.');
          toolCount++;
          result = await runAgentTerminal(call.input, options);
        }
      } catch (error: any) {
        result = { error: error?.message || 'The requested tool call could not be run.' };
      }
      toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result).slice(0, 30_000), is_error: Boolean(result.error) });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  throw new Error('Provider exceeded the 10-round terminal tool-call limit without a final response.');
}

async function runAgentTerminal(input: unknown, options: {
  signal: AbortSignal; chatId: string; allowNetwork: boolean; send: AgentSend;
}): Promise<any> {
  options.send('activity', { message: 'Starting an isolated Docker command requested by the model.' });
  return executeAgentTerminal(input, {
    chatId: options.chatId,
    allowNetwork: options.allowNetwork,
    signal: options.signal,
    onEvent: event => {
      if (event.type === 'start') options.send('activity', { message: `Running terminal command in Docker · ${String(event.command || '').slice(0, 180)}` });
      if (event.type === 'end') options.send('activity', { message: `Terminal command ${String(event.status || 'finished')}.` });
      const eventName = event.type === 'start' ? 'tool-start' : event.type === 'output' ? 'tool-output' : 'tool-end';
      options.send(eventName, event);
    },
  });
}

async function postProviderChat(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  onTextDelta: (delta: string) => void,
): Promise<{ response: any; streamedText: string }> {
  const response = await fetchToolEnabledResponse(url, headers, body, signal);
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new ProviderHttpError(response.status, 'Tool-enabled chat request');
  }
  if (!(response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream')) {
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error('Provider response exceeded the 2 MB limit.');
    try { return { response: JSON.parse(text), streamedText: '' }; }
    catch { throw new Error('Provider returned invalid JSON for the tool-enabled request.'); }
  }

  let assistantText = '';
  let finishReason = '';
  const calls = new Map<number, any>();
  const sawDone = await readProviderSse(response, event => {
    if (event?.error) throw new Error(String(event.error.message || 'Provider streaming request failed.'));
    const choice = event?.choices?.[0];
    if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
    const delta = choice?.delta;
    if (typeof delta?.content === 'string' && delta.content) {
      assistantText += delta.content;
      if (assistantText.length > 2_000_000) throw new Error('Provider response exceeded the 2 MB limit.');
      onTextDelta(delta.content);
    }
    if (!Array.isArray(delta?.tool_calls)) return;
    for (const toolDelta of delta.tool_calls) {
      const index = Number.isInteger(toolDelta?.index) ? toolDelta.index : calls.size;
      const call = calls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (typeof toolDelta?.id === 'string') call.id = toolDelta.id;
      if (typeof toolDelta?.type === 'string') call.type = toolDelta.type;
      if (typeof toolDelta?.function?.name === 'string') call.function.name += toolDelta.function.name;
      if (typeof toolDelta?.function?.arguments === 'string') call.function.arguments += toolDelta.function.arguments;
      calls.set(index, call);
    }
  });
  if (!sawDone && !finishReason) throw new Error('Provider stream ended before the response was complete.');

  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  return {
    response: { choices: [{ message: { role: 'assistant', content: assistantText || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }] },
    streamedText: assistantText,
  };
}

async function postAnthropicChat(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  onTextDelta: (delta: string) => void,
): Promise<{ response: any; streamedText: string }> {
  const response = await fetchToolEnabledResponse(url, headers, body, signal);
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new ProviderHttpError(response.status, 'Tool-enabled chat request');
  }
  if (!(response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream')) {
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error('Provider response exceeded the 2 MB limit.');
    try { return { response: JSON.parse(text), streamedText: '' }; }
    catch { throw new Error('Provider returned invalid JSON for the tool-enabled request.'); }
  }

  let streamedText = '';
  let stopReason: string | undefined;
  let messageStopped = false;
  const blocks = new Map<number, any>();
  const partialInputs = new Map<number, string>();
  const sawDone = await readProviderSse(response, event => {
    if (event?.type === 'error' || event?.error) throw new Error(String(event?.error?.message || 'Provider streaming request failed.'));
    if (event?.type === 'message_stop') messageStopped = true;
    if (event?.type === 'message_delta' && typeof event.delta?.stop_reason === 'string') stopReason = event.delta.stop_reason;
    const index = Number.isInteger(event?.index) ? event.index : 0;
    if (event?.type === 'content_block_start' && event.content_block && typeof event.content_block === 'object') {
      blocks.set(index, { ...event.content_block });
      return;
    }
    if (event?.type === 'content_block_delta') {
      const block = blocks.get(index) || {};
      if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        block.text = `${block.text || ''}${event.delta.text}`;
        streamedText += event.delta.text;
        if (streamedText.length > 2_000_000) throw new Error('Provider response exceeded the 2 MB limit.');
        onTextDelta(event.delta.text);
      } else if (event.delta?.type === 'input_json_delta' && typeof event.delta.partial_json === 'string') {
        partialInputs.set(index, `${partialInputs.get(index) || ''}${event.delta.partial_json}`);
      }
      blocks.set(index, block);
      return;
    }
    if (event?.type === 'content_block_stop') {
      const partial = partialInputs.get(index);
      if (partial) {
        try { (blocks.get(index) || {}).input = JSON.parse(partial); }
        catch { throw new Error('Provider returned invalid tool arguments in its streaming response.'); }
        partialInputs.delete(index);
      }
    }
  });
  if (!sawDone && !messageStopped) throw new Error('Provider stream ended before the response was complete.');
  return { response: { content: [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block), stop_reason: stopReason }, streamedText };
}

type ProviderFetchResponse = Awaited<ReturnType<typeof fetch>>;

async function fetchToolEnabledResponse(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<ProviderFetchResponse> {
  const request = (requestBody: unknown) => fetch(url, {
    method: 'POST', headers, body: JSON.stringify(requestBody), signal,
  });
  const first = await request(body);
  if (first.status !== 400 || !body || typeof body !== 'object' || Array.isArray(body)) return first;

  const original = body as Record<string, unknown>;
  let response = first;
  let retryBody = original;
  if (original.stream === true) {
    // Some otherwise compatible providers reject SSE when tools are present. Retry the same
    // tool request as JSON; permissions and tool definitions remain unchanged.
    void response.body?.cancel().catch(() => {});
    retryBody = { ...original, stream: false };
    response = await request(retryBody);
    if (response.status !== 400) return response;
  }

  if (Object.prototype.hasOwnProperty.call(retryBody, 'tool_choice')) {
    // Several OpenAI-compatible endpoints support function tools but reject an explicit
    // `tool_choice: "auto"`. Omitting it preserves the tools and lets the endpoint use its
    // documented default. This also lets models choose a tool after a forced-image attempt.
    void response.body?.cancel().catch(() => {});
    const compatibleBody = { ...retryBody };
    delete compatibleBody.tool_choice;
    response = await request(compatibleBody);
  }
  return response;
}

async function readProviderSse(response: Pick<ProviderFetchResponse, 'body'>, onEvent: (event: any) => void): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Provider returned an empty streaming response.');
  const decoder = new TextDecoder();
  let buffer = '';
  let receivedBytes = 0;
  let finished = false;
  let sawDone = false;
  const parseBlock = (block: string) => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
    if (!data) return;
    if (data === '[DONE]') { finished = true; sawDone = true; return; }
    try { onEvent(JSON.parse(data)); }
    catch (error: any) {
      if (error instanceof SyntaxError) throw new Error('Provider returned invalid JSON in its streaming response.');
      throw error;
    }
  };
  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > 2_000_000) {
        await reader.cancel().catch(() => {});
        throw new Error('Provider response exceeded the 2 MB limit.');
      }
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || '';
      for (const block of blocks) {
        parseBlock(block);
        if (finished) break;
      }
    }
    if (!finished) buffer += decoder.decode();
    if (!finished && buffer.trim()) parseBlock(buffer);
    return sawDone;
  } finally {
    reader.releaseLock();
  }
}

function providerText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('');
  return '';
}

function hasExplicitImageRequest(messages: { role: string; content: any }[]): boolean {
  const latestUserMessage = [...messages].reverse().find(message => message.role === 'user');
  const text = providerText(latestUserMessage?.content);
  const image = '(?:image|picture|photo|illustration|artwork|logo|poster|icon|thumbnail)';
  const creation = '(?:create|generate|make|draw|paint|illustrate|render|design)';
  return new RegExp(`\\b${creation}\\b[\\s\\S]{0,120}\\b${image}\\b`, 'i').test(text)
    || new RegExp(`\\b${image}\\b[\\s\\S]{0,120}\\b${creation}\\b`, 'i').test(text)
    || new RegExp(`\\b(?:need|want|would like|looking for)\\b[\\s\\S]{0,80}\\b${image}\\b`, 'i').test(text)
    || new RegExp(`\\b(?:can you|could you|please)\\b[\\s\\S]{0,80}\\b(?:give me|show me)\\b[\\s\\S]{0,40}\\b${image}\\b`, 'i').test(text);
}

function toAnthropicContent(content: any): any {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const blocks: any[] = [];
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') blocks.push({ type: 'text', text: part.text });
    if (part?.type !== 'image_url' || typeof part.image_url?.url !== 'string') continue;
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.image_url.url);
    if (match) blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
  }
  return blocks;
}

async function listModelsForProvider(row: any, apiKey: string): Promise<ModelInfo[]> {
  if (row.kind === 'manus-agent') return MANUS_PROFILES.map(model => ({ ...model }));
  const base = (row.base_url || '').replace(/\/+$/, '');
  if (!base) throw new Error('Provider has no base URL set.');
  const isAnthropic = row.kind === 'anthropic-compatible';
  const url = appendEndpoint(base, isAnthropic ? '/v1/models' : '/models');
  const headers: Record<string, string> = {
    ...(isAnthropic ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : (apiKey ? { Authorization: `Bearer ${apiKey}` } : {})),
    ...JSON.parse(row.custom_headers || '{}'),
  };
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) {
    void resp.body?.cancel().catch(() => {});
    throw new ProviderHttpError(resp.status, 'Model discovery');
  }
  const json = await resp.json();
  const models: ModelInfo[] = (json?.data ?? json?.models ?? []).map((m: any) => ({
    id: m?.id || m?.name || '',
    label: m?.id || m?.name || '',
    capabilities: ['text'], // Providers don't uniformly advertise capabilities; default to text.
  })).filter((m: ModelInfo) => m.id);
  return models;
}

class ProviderHttpError extends Error {
  constructor(readonly status: number, readonly operation: string) {
    super(`${operation} failed.`);
    this.name = 'ProviderHttpError';
  }
}

function safeProviderStatusError(status: number, operation: string): string {
  const detail = status === 401 || status === 403 ? 'authentication was rejected'
    : status === 404 ? 'the endpoint was not found'
    : status === 429 ? 'the provider rate limit was reached'
    : status === 400 && operation === 'Tool-enabled chat request' ? 'the provider rejected the tool-enabled request; Gnito could not determine whether the cause is the endpoint, model, or request format'
    : status === 400 && operation === 'Image generation' ? 'the image endpoint rejected the request; check Images API support and the selected image model/size'
    : status === 400 && operation === 'Vision chat request' ? 'the provider rejected image input; choose a vision-capable model and supported image format'
    : status === 400 ? 'the request was rejected; check the model ID and request settings'
    : status >= 500 ? 'the provider returned a server error'
    : 'the provider rejected the request';
  return `${operation} failed (HTTP ${status}: ${detail}).`;
}

function safeProviderError(error: unknown, operation: string): string {
  if (error instanceof ProviderHttpError) return safeProviderStatusError(error.status, error.operation || operation);
  const err = error as { name?: string; code?: string; cause?: { code?: string } } | null;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `${operation} timed out.`;
  if (err?.name === 'SyntaxError') return `${operation} returned invalid JSON.`;
  const code = err?.cause?.code || err?.code;
  const safeCodes = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'CERT_HAS_EXPIRED', 'SELF_SIGNED_CERT_IN_CHAIN']);
  if (code && safeCodes.has(code)) return `${operation} could not connect to the provider (${code}). Check the base URL and network.`;
  return `${operation} failed. Check the provider base URL, credentials, and network connection.`;
}

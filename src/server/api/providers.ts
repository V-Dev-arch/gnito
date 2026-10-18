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

const db = getDb();

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
  kind: z.enum(['openai-compatible', 'anthropic-compatible', 'custom']),
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
        content: z.string().max(200_000),
      })).min(1).max(200),
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().positive().max(128_000).optional(),
      stream: z.boolean().default(true),
    });
    const parsed = ChatRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation', issues: parsed.error.issues });
      return;
    }
    const body = parsed.data;
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
    res.on('close', () => {
      if (!res.writableEnded && abortController) abortController.abort();
    });

    try {
      abortController = new AbortController();
      const url = buildChatUrl(row);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(row.kind === 'anthropic-compatible'
          ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
          : (apiKey ? { Authorization: `Bearer ${apiKey}` } : {})),
        ...JSON.parse(row.custom_headers || '{}'),
      };

      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(
          row.kind === 'anthropic-compatible'
            ? {
                model: body.model,
                messages: body.messages.filter(m => m.role !== 'system'),
                system: body.messages.find(m => m.role === 'system')?.content,
                stream: body.stream,
                temperature: body.temperature,
                max_tokens: body.maxTokens,
              }
            : {
                model: body.model,
                messages: body.messages,
                stream: body.stream,
                temperature: body.temperature,
                max_tokens: body.maxTokens,
              }
        ),
        signal: abortController.signal,
      });

      if (!resp.ok) {
        void resp.body?.cancel().catch(() => {});
        send('error', { message: safeProviderStatusError(resp.status, 'Chat request') });
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
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const path = endpoint.startsWith('/v1/') && /\/v1$/i.test(base) ? endpoint.slice(3) : endpoint;
  return `${base}${path}`;
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

async function listModelsForProvider(row: any, apiKey: string): Promise<ModelInfo[]> {
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
    : status === 400 ? 'the request was rejected; check the model ID and request settings'
    : status >= 500 ? 'the provider returned a server error'
    : 'the provider rejected the request';
  return `${operation} failed (HTTP ${status}: ${detail}).`;
}

function safeProviderError(error: unknown, operation: string): string {
  if (error instanceof ProviderHttpError) return safeProviderStatusError(error.status, operation);
  const err = error as { name?: string; code?: string; cause?: { code?: string } } | null;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `${operation} timed out.`;
  if (err?.name === 'SyntaxError') return `${operation} returned invalid JSON.`;
  const code = err?.cause?.code || err?.code;
  const safeCodes = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'CERT_HAS_EXPIRED', 'SELF_SIGNED_CERT_IN_CHAIN']);
  if (code && safeCodes.has(code)) return `${operation} could not connect to the provider (${code}). Check the base URL and network.`;
  return `${operation} failed. Check the provider base URL, credentials, and network connection.`;
}

/**
 * Gnito — typed API client.
 * Wraps fetch with session token + CSRF header. No localStorage.
 */
let SESSION_TOKEN: string | null = null;
let CSRF_TOKEN: string | null = null;

function describeHttpError(payload: any, status: number): string {
  if (typeof payload?.message === 'string' && payload.message) return payload.message;
  if (Array.isArray(payload?.issues)) {
    const details = payload.issues.slice(0, 5).map((issue: any) => {
      const path = Array.isArray(issue?.path) ? issue.path.filter((part: unknown) => typeof part === 'string' || typeof part === 'number').join('.') : '';
      const message = typeof issue?.message === 'string' ? issue.message : '';
      return [path || 'request', message].filter(Boolean).join(': ');
    }).filter(Boolean).join('; ');
    if (details) return `Request validation failed: ${details}`;
  }
  if (typeof payload?.error === 'string' && payload.error !== 'validation') return payload.error;
  return `Request failed (${status})`;
}

export function setSession(token: string, csrf: string): void {
  SESSION_TOKEN = token;
  CSRF_TOKEN = csrf;
}

export function clearSession(): void {
  SESSION_TOKEN = null;
  CSRF_TOKEN = null;
}

export function hasSession(): boolean { return !!SESSION_TOKEN; }

async function request<T = any>(method: string, path: string, body?: any): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(SESSION_TOKEN ? { 'X-Gnito-Session': SESSION_TOKEN } : {}),
    ...(CSRF_TOKEN ? { 'X-Gnito-CSRF': CSRF_TOKEN } : {}),
  };
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try { message = describeHttpError(await res.json(), res.status); } catch {}
    throw new Error(message);
  }
  return res.json();
}

export const api = {
  get: <T = any>(path: string) => request<T>('GET', path),
  post: <T = any>(path: string, body?: any) => request<T>('POST', path, body),
  put: <T = any>(path: string, body?: any) => request<T>('PUT', path, body),
  patch: <T = any>(path: string, body?: any) => request<T>('PATCH', path, body),
  delete: <T = any>(path: string, body?: any) => request<T>('DELETE', path, body),
  mediaBlob: async (path: string): Promise<Blob> => {
    const res = await fetch(path, { headers: { 'X-Gnito-Session': SESSION_TOKEN || '', 'X-Gnito-CSRF': CSRF_TOKEN || '' } });
    if (!res.ok) throw new Error(`Media request failed (${res.status})`);
    return res.blob();
  },

  /** Stream a chat response via SSE. Returns AbortController synchronously for cancellation. */
  streamChat: (providerId: string, body: any, onChunk: (delta: string) => void, onEnd: (finalText: string) => void, onError: (msg: string) => void, incognito = false, onActivity?: (message: string) => void, onToolEvent?: (event: any) => void, onMediaEvent?: (event: any) => void): AbortController => {
    const controller = new AbortController();
    let finalText = '';
    let settled = false;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      onError(message);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      onEnd(finalText);
    };

    (async () => {
      try {
        const res = await fetch(`/api/providers/${providerId}/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Gnito-Session': SESSION_TOKEN || '',
            'X-Gnito-CSRF': CSRF_TOKEN || '',
            ...(incognito ? { 'X-Gnito-Incognito': '1' } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          let message = `Request failed (${res.status})`;
          const contentType = res.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            try {
              message = describeHttpError(await res.json(), res.status);
            } catch { /* use status below */ }
          } else {
            message = (await res.text().catch(() => '')).slice(0, 600).trim() || message;
          }
          fail(message);
          return;
        }
        if (!res.body) {
          fail('The provider returned an empty response stream.');
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const dispatch = (block: string) => {
          if (settled) return;
          const lines = block.replace(/^\uFEFF/, '').split(/\r?\n/);
          let name = '';
          const dataLines: string[] = [];
          for (const line of lines) {
            if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
          }
          const data = dataLines.join('\n');
          if (name === 'chunk') {
            let payload: any;
            try { payload = JSON.parse(data); }
            catch { fail('The provider sent invalid text in its response stream.'); return; }
            if (typeof payload?.delta !== 'string') return;
            finalText += payload.delta;
            onChunk(payload.delta);
          } else if (name === 'activity') {
            try { onActivity?.(JSON.parse(data).message || ''); }
            catch { fail('The provider sent invalid activity data.'); }
          } else if (name === 'tool-start' || name === 'tool-output' || name === 'tool-end') {
            try { onToolEvent?.(JSON.parse(data)); }
            catch { fail('The provider sent invalid terminal-tool data.'); }
          } else if (name === 'media') {
            try { onMediaEvent?.(JSON.parse(data)); }
            catch { fail('The provider sent invalid media data.'); }
          } else if (name === 'error') {
            try { fail(JSON.parse(data).message || 'Unknown error'); }
            catch { fail('Unknown error'); }
          } else if (name === 'end') {
            finish();
          }
        };

        while (!settled) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            if (buffer.trim()) dispatch(buffer);
            if (!settled) fail('The response stream ended before Gnito received a completion event. Any partial text has been kept.');
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() || '';
          for (const block of blocks) {
            dispatch(block);
            if (settled) break;
          }
        }
        if (settled) void reader.cancel().catch(() => {});
        reader.releaseLock();
      } catch (e: any) {
        if (e?.name !== 'AbortError') fail(e?.message || 'Network error');
      }
    })();

    return controller;
  },
};

/**
 * Gnito — typed API client.
 * Wraps fetch with session token + CSRF header. No localStorage.
 */
let SESSION_TOKEN: string | null = null;
let CSRF_TOKEN: string | null = null;

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
    let message = '';
    try { const j = await res.json(); message = j.message || j.error || ''; } catch {}
    throw new Error(message || `Request failed (${res.status})`);
  }
  return res.json();
}

export const api = {
  get: <T = any>(path: string) => request<T>('GET', path),
  post: <T = any>(path: string, body?: any) => request<T>('POST', path, body),
  put: <T = any>(path: string, body?: any) => request<T>('PUT', path, body),
  patch: <T = any>(path: string, body?: any) => request<T>('PATCH', path, body),
  delete: <T = any>(path: string, body?: any) => request<T>('DELETE', path, body),

  /** Stream a chat response via SSE. Returns AbortController synchronously for cancellation. */
  streamChat: (providerId: string, body: any, onChunk: (delta: string) => void, onEnd: (finalText: string) => void, onError: (msg: string) => void): AbortController => {
    const controller = new AbortController();
    let finalText = '';

    (async () => {
      try {
        const res = await fetch(`/api/providers/${providerId}/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Gnito-Session': SESSION_TOKEN || '',
            'X-Gnito-CSRF': CSRF_TOKEN || '',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          onError(`Request failed (${res.status})`);
          return;
        }
        const reader = (res.body as ReadableStream).getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const events = buf.split('\n\n');
          buf = events.pop() || '';
          for (const ev of events) {
            const lines = ev.split('\n');
            let name = '';
            let data = '';
            for (const l of lines) {
              if (l.startsWith('event:')) name = l.slice(6).trim();
              else if (l.startsWith('data:')) data += l.slice(5);
            }
            if (name === 'chunk') {
              try { const d = JSON.parse(data).delta || ''; finalText += d; onChunk(d); } catch {}
            } else if (name === 'error') {
              try { onError(JSON.parse(data).message || 'Unknown error'); } catch { onError('Unknown error'); }
              return;
            } else if (name === 'end') {
              onEnd(finalText);
              return;
            }
          }
        }
        onEnd(finalText);
      } catch (e: any) {
        if (e?.name !== 'AbortError') onError(e?.message || 'Network error');
      }
    })();

    return controller;
  },
};

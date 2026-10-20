import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, clearSession, setSession } from '../../src/client/lib/api.js';

function streamResponse(parts: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function collect(parts: string[]): Promise<{ kind: 'end' | 'error'; text: string; error?: string; chunks: string[] }> {
  setSession('test-session', 'test-csrf');
  vi.stubGlobal('fetch', vi.fn(async () => streamResponse(parts)));
  return new Promise(resolve => {
    let text = '';
    const chunks: string[] = [];
    api.streamChat('provider', { model: 'test', messages: [] }, delta => {
      chunks.push(delta);
      text += delta;
    }, finalText => resolve({ kind: 'end', text: finalText, chunks }), message => resolve({ kind: 'error', text, error: message, chunks }));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearSession();
});

describe('chat client SSE parsing', () => {
  it('preserves split CRLF frames and emits a single completed response', async () => {
    const result = await collect([
      'event: chunk\r\ndata: {"delta":"Hello"}\r',
      '\n\r\nevent: chunk\r\ndata: {"delta":" world"}\r\n\r\nevent: end\r\n\r\n',
    ]);
    expect(result).toEqual({ kind: 'end', text: 'Hello world', chunks: ['Hello', ' world'] });
  });

  it('keeps delivered text and reports an error instead of hiding it', async () => {
    const result = await collect([
      'event: chunk\ndata: {"delta":"partial answer"}\n\n',
      'event: error\ndata: {"message":"upstream stopped"}\n\n',
      'event: end\ndata: {}\n\n',
    ]);
    expect(result).toMatchObject({ kind: 'error', text: 'partial answer', error: 'upstream stopped', chunks: ['partial answer'] });
  });

  it('processes the final frame at EOF and reports a truncated stream without a completion event', async () => {
    const result = await collect(['event: chunk\ndata: {"delta":"last visible text"}']);
    expect(result.kind).toBe('error');
    expect(result.text).toBe('last visible text');
    expect(result.error).toContain('ended before Gnito received a completion event');
  });

  it('surfaces malformed event JSON without invoking the success callback', async () => {
    const result = await collect(['event: chunk\ndata: {not json}\n\n']);
    expect(result.kind).toBe('error');
    expect(result.error).toContain('invalid text');
    expect(result.chunks).toEqual([]);
  });
});

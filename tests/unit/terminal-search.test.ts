import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchPublicUrl, isPublicIp, resolvePublicAddresses } from '../../src/server/security/publicFetch.js';

let tempDir = '';
let originalDataDir: string | undefined;
let originalDockerBin: string | undefined;
let closeDb: (() => void) | undefined;
let getSandboxStatus: any;
let runSandboxCommand: any;
let buildDockerRunArgs: any;
let webSearch: any;
let executeWebSearch: any;
let readUrl: any;
let toolRegistry: Map<string, any>;
let parseDuckDuckGoResults: any;
let parseBingResults: any;
let parseBraveResults: any;
let registerToolRoutes: any;
let db: any;
let nativeFetch: typeof fetch;
let server: any;
let apiBase = '';

beforeAll(async () => {
  originalDataDir = process.env.GNITO_DATA_DIR;
  originalDockerBin = process.env.GNITO_DOCKER_BIN;
  nativeFetch = globalThis.fetch.bind(globalThis);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnito-terminal-search-'));
  process.env.GNITO_DATA_DIR = tempDir;
  process.env.GNITO_DOCKER_BIN = path.join(tempDir, 'docker-does-not-exist');
  vi.resetModules();
  const dbModule = await import('../../src/server/db/index.js');
  db = dbModule.getDb();
  closeDb = dbModule.closeDb;
  const sandbox = await import('../../src/server/sandbox/docker.js');
  getSandboxStatus = sandbox.getSandboxStatus;
  runSandboxCommand = sandbox.runSandboxCommand;
  buildDockerRunArgs = sandbox.buildDockerRunArgs;
  const tools = await import('../../src/server/api/tools.js');
  webSearch = tools.TOOL_REGISTRY.get('web_search');
  executeWebSearch = tools.executeWebSearch;
  readUrl = tools.TOOL_REGISTRY.get('read_url');
  toolRegistry = tools.TOOL_REGISTRY;
  parseDuckDuckGoResults = tools.parseDuckDuckGoResults;
  parseBingResults = tools.parseBingResults;
  parseBraveResults = tools.parseBraveResults;
  registerToolRoutes = tools.registerToolRoutes;
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  registerToolRoutes(app);
  server = await new Promise<any>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  apiBase = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.GNITO_DATA_DIR;
  else process.env.GNITO_DATA_DIR = originalDataDir;
  if (originalDockerBin === undefined) delete process.env.GNITO_DOCKER_BIN;
  else process.env.GNITO_DOCKER_BIN = originalDockerBin;
});

async function postJson(route: string, payload: unknown) {
  const response = await nativeFetch(`${apiBase}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  return { response, body: await response.json() as any };
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('Public outbound URL policy', () => {
  it('allows globally routable addresses and rejects private, link-local, mapped, and reserved ranges', () => {
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('2001:4860:4860::8888')).toBe(true);
    for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '2001:db8::1', '::ffff:169.254.169.254', '64:ff9b::808:808']) {
      expect(isPublicIp(address), address).toBe(false);
    }
  });

  it('rejects mixed public/private DNS answers and pins only validated public answers', async () => {
    await expect(resolvePublicAddresses('search.example', async () => [
      { address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 },
    ])).rejects.toThrow('public IP addresses');
    await expect(resolvePublicAddresses('search.example', async () => [
      { address: '93.184.216.34', family: 4 },
    ])).resolves.toEqual([{ address: '93.184.216.34', family: 4 }]);
    await expect(fetchPublicUrl(new URL('https://[::ffff:169.254.169.254]/'))).rejects.toThrow('public IP addresses');
  });
});

describe('Docker terminal sandbox', () => {
  it('builds a container invocation with network, filesystem, capability, storage and resource restrictions', () => {
    const args = buildDockerRunArgs({ command: 'pwd && ls', containerName: 'gnito-terminal-test', workspaceDir: '/tmp/gnito-workspace', image: 'gnito-sandbox:test', uid: 1000, gid: 1000 });
    expect(args).toContain('--network=none');
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges:true');
    expect(args).toContain('--pids-limit=64');
    expect(args).toContain('--memory=512m');
    expect(args).toContain('--cpus=1');
    expect(args).toContain('fsize=134217728:134217728');
    expect(args).toContain('--pull=never');
    expect(args).toContain('--init');
    expect(args).toContain('type=bind,source=/tmp/gnito-workspace,target=/workspace');
    expect(args).toContain('--user');
    expect(args).toContain('1000:1000');
    expect(args.at(-1)).toBe('pwd && ls');
    expect(args.join(' ')).not.toContain('docker.sock');
    expect(() => buildDockerRunArgs({ command: 'id', containerName: 'root-test', workspaceDir: '/tmp/ws', uid: 0, gid: 0 })).toThrow('non-root UID');
  });

  it('uses Docker bridge networking only when network access is explicitly enabled', () => {
    const args = buildDockerRunArgs({ command: 'curl https://example.com', containerName: 'gnito-terminal-network-test', workspaceDir: '/tmp/gnito-workspace', uid: 1000, gid: 1000, networkAccess: true });
    expect(args).toContain('--network=bridge');
  });

  it('reports an unavailable runtime and never executes the command on the host', async () => {
    const status = await getSandboxStatus();
    expect(status.available).toBe(false);
    const sentinel = path.join(tempDir, 'host-fallback-must-not-exist');
    const result = await runSandboxCommand(`touch ${sentinel}`, 1_000, new AbortController().signal);
    expect(result.error).toContain('host shell will not be used');
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('exposes actual Docker availability through the status route', async () => {
    const response = await nativeFetch(`${apiBase}/api/tools/sandbox/status`);
    const status = await response.json() as any;
    expect(status.provider).toBe('docker');
    expect(status.available).toBe(false);
  });
});

describe('Web search', () => {
  it('bounds and normalizes DuckDuckGo results while filtering non-web links', () => {
    const html = `
      <div class="result"><a class="result__a" href="https://example.com/article?a=1&amp;b=2">Example &amp; Article</a>
      <a class="result__snippet">A &lt;useful&gt; snippet &amp; detail.</a></div>
      <div class="result"><a class="result__a" href="javascript:alert(1)">Bad link</a></div>`;
    const results = parseDuckDuckGoResults(html, new URL('https://html.duckduckgo.com/html/'), 5);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ title: 'Example & Article', url: 'https://example.com/article?a=1&b=2', snippet: 'A <useful> snippet & detail.' });
  });

  it('decodes Bing tracking URLs and extracts bounded titles and snippets', () => {
    const html = '<ol><li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS8&amp;ntb=1">Example &amp; Title</a></h2><div class="b_caption"><p>Useful <b>source</b> snippet.</p></div></li></ol>';
    const results = parseBingResults(html, new URL('https://www.bing.com/search'), 5);
    expect(results).toEqual([{ title: 'Example & Title', url: 'https://example.com/', snippet: 'Useful source snippet.' }]);
  });

  it('extracts Brave Search result-card titles, source links and snippets', () => {
    const html = '<a href="https://example.com/docs" target="_self"><div class="title search-snippet-title">Example &amp; Title</div></a><div class="generic-snippet"><div class="content">Helpful <strong>source</strong> snippet.</div></div>';
    const results = parseBraveResults(html, new URL('https://search.brave.com/search'), 5);
    expect(results).toEqual([{ title: 'Example & Title', url: 'https://example.com/docs', snippet: 'Helpful source snippet.' }]);
  });

  it('falls back once from default Brave Search after a 429', async () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('workspace.searchBackend', '')").run();
    const visited: string[] = [];
    const result = await executeWebSearch({ query: 'current test', maxResults: 5 }, new AbortController().signal, async (url: URL) => {
      visited.push(url.hostname);
      if (url.hostname === 'search.brave.com') {
        return { status: 429, headers: { get: name => name === 'retry-after' ? '30' : null }, body: 'rate limited' };
      }
      return {
        status: 200,
        headers: { get: name => name === 'content-type' ? 'text/html' : null },
        body: '<a class="result__a" href="https://example.com/article">Current source</a><a class="result__snippet">A useful result.</a>',
      };
    });
    expect(visited).toEqual(['search.brave.com', 'html.duckduckgo.com']);
    expect(result.error).toBeUndefined();
    expect(result.output.results).toEqual([{ title: 'Current source', url: 'https://example.com/article', snippet: 'A useful result.' }]);
  });

  it('reports an explicitly configured backend 429 and Retry-After without switching providers', async () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('workspace.searchBackend', ?)").run('https://search.example/search');
    let calls = 0;
    const result = await executeWebSearch({ query: 'current test', maxResults: 5 }, new AbortController().signal, async () => {
      calls++;
      return { status: 429, headers: { get: name => name === 'retry-after' ? '45' : null }, body: 'private upstream body' };
    });
    expect(calls).toBe(1);
    expect(result.error).toContain('HTTP 429');
    expect(result.error).toContain('Retry-After: 45');
    expect(result.error).not.toContain('private upstream body');
  });

  it('persists the run and can link a first-turn search to its newly created chat', async () => {
    const originalExecute = webSearch.execute;
    webSearch.execute = async (input: any) => ({ output: { query: input.query, results: [{ title: 'Test source', url: 'https://example.com/', snippet: 'Result' }] } });
    try {
      db.prepare(`INSERT INTO chats (id, project_id, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
        .run('search-chat', null, 'Search test', 'active', Date.now(), Date.now());
      const { response, body } = await postJson('/api/tools/web-search', { query: 'current test', maxResults: 5 });
      expect(response.status).toBe(200);
      expect(body.status).toBe('succeeded');
      const beforeLink = db.prepare('SELECT context FROM tool_runs WHERE id = ?').get(body.runId) as any;
      expect(beforeLink.context).toBeNull();
      const linked = await nativeFetch(`${apiBase}/api/tools/runs/${body.runId}/context`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: 'search-chat' }),
      });
      expect(linked.status).toBe(200);
      const afterLink = db.prepare('SELECT status, context FROM tool_runs WHERE id = ?').get(body.runId) as any;
      expect(afterLink).toEqual({ status: 'succeeded', context: 'search-chat' });
    } finally { webSearch.execute = originalExecute; }
  });

  it('refuses a configured loopback search backend before opening a socket', async () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('workspace.searchBackend', ?)").run('https://127.0.0.1/search');
    const { response, body } = await postJson('/api/tools/web-search', { query: 'private endpoint', maxResults: 1 });
    expect(response.status).toBe(502);
    expect(body.error).toContain('public IP addresses');
  });

  it('applies the same public-address policy to read_url', async () => {
    const result = await readUrl.execute({ url: 'http://169.254.169.254/latest/meta-data/', maxChars: 1_000 }, new AbortController().signal);
    expect(result.error).toContain('public IP addresses');
  });
});

describe('Tool execution state machine', () => {
  it('claims an approved run only once and stops it through the cancel route', async () => {
    const { z } = await import('zod');
    let executionCount = 0;
    const toolName = 'test_wait_tool';
    toolRegistry.set(toolName, {
      name: toolName, description: 'test-only wait', permissions: [], requiresConfirmation: true,
      inputSchema: z.object({}),
      execute: (_input: unknown, signal: AbortSignal) => new Promise(resolve => {
        executionCount++;
        signal.addEventListener('abort', () => resolve({ error: 'cancelled' }), { once: true });
      }),
    });
    try {
      const { body: request } = await postJson(`/api/tools/${toolName}/request`, { context: 'terminal-ui' });
      await nativeFetch(`${apiBase}/api/tools/runs/${request.runId}/approve`, { method: 'POST' });
      const firstExecution = nativeFetch(`${apiBase}/api/tools/runs/${request.runId}/execute`, { method: 'POST' }).then(async response => ({ status: response.status, body: await response.json() as any }));
      for (let attempt = 0; attempt < 30; attempt++) {
        const row = db.prepare('SELECT status FROM tool_runs WHERE id = ?').get(request.runId) as any;
        if (row.status === 'running') break;
        await wait(10);
      }
      const replay = await nativeFetch(`${apiBase}/api/tools/runs/${request.runId}/execute`, { method: 'POST' });
      expect(replay.status).toBe(409);
      const cancelled = await nativeFetch(`${apiBase}/api/tools/runs/${request.runId}/cancel`, { method: 'POST' });
      expect(cancelled.status).toBe(200);
      const first = await firstExecution;
      expect(first.status).toBe(200);
      expect(first.body.status).toBe('cancelled');
      expect(executionCount).toBe(1);
    } finally { toolRegistry.delete(toolName); }
  });
});


describe('Terminal routes', () => {
  it('records a hard sandbox failure without executing on the host', async () => {
    const sentinel = path.join(tempDir, 'route-host-fallback-must-not-exist');
    const { response: requestResponse, body: request } = await postJson('/api/tools/terminal_run/request', { command: `touch ${sentinel}`, timeoutMs: 1_000, context: 'terminal-ui' });
    expect(requestResponse.status).toBe(201);
    await nativeFetch(`${apiBase}/api/tools/runs/${request.runId}/approve`, { method: 'POST' });
    const executionResponse = await nativeFetch(`${apiBase}/api/tools/runs/${request.runId}/execute`, { method: 'POST' });
    const execution = await executionResponse.json() as any;
    expect(execution.status).toBe('failed');
    expect(execution.error).toContain('host shell will not be used');
    expect(fs.existsSync(sentinel)).toBe(false);
    const row = db.prepare('SELECT status, context FROM tool_runs WHERE id = ?').get(request.runId) as any;
    expect(row).toEqual({ status: 'failed', context: 'terminal-ui' });
  });
});

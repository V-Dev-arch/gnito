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
let openSandboxMediaFile: any;
let webSearch: any;
let executeWebSearch: any;
let readUrl: any;
let toolRegistry: Map<string, any>;
let parseDuckDuckGoResults: any;
let parseBingResults: any;
let parseBraveResults: any;
let registerToolRoutes: any;
let executeAgentTerminal: any;
let storeGeneratedPng: any;
let registerMediaRoutes: any;
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
  openSandboxMediaFile = sandbox.openSandboxMediaFile;
  const tools = await import('../../src/server/api/tools.js');
  webSearch = tools.TOOL_REGISTRY.get('web_search');
  executeWebSearch = tools.executeWebSearch;
  readUrl = tools.TOOL_REGISTRY.get('read_url');
  toolRegistry = tools.TOOL_REGISTRY;
  parseDuckDuckGoResults = tools.parseDuckDuckGoResults;
  parseBingResults = tools.parseBingResults;
  parseBraveResults = tools.parseBraveResults;
  registerToolRoutes = tools.registerToolRoutes;
  executeAgentTerminal = tools.executeAgentTerminal;
  const media = await import('../../src/server/api/media.js');
  storeGeneratedPng = media.storeGeneratedPng;
  registerMediaRoutes = media.registerMediaRoutes;
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  registerToolRoutes(app);
  registerMediaRoutes(app);
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
    expect(args).toContain('fsize=1073741824:1073741824');
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

  it('applies the message-level network grant without relying on a second model-supplied flag', async () => {
    const terminalTool = toolRegistry.get('terminal_run');
    const originalExecute = terminalTool.execute;
    terminalTool.execute = async (input: any) => ({ output: { exitCode: 0, stdout: String(input.networkAccess), stderr: '' } });
    try {
      const granted = await executeAgentTerminal({ command: 'curl https://example.com', timeoutMs: 1_000, networkAccess: false }, {
        chatId: 'network-granted-test', allowNetwork: true, signal: new AbortController().signal,
      });
      const grantedRow = db.prepare('SELECT input FROM tool_runs WHERE id = ? LIMIT 1').get(granted.runId) as any;
      expect(JSON.parse(grantedRow.input).networkAccess).toBe(true);
      expect(granted.output.stdout).toBe('true');

      const denied = await executeAgentTerminal({ command: 'curl https://example.com', timeoutMs: 1_000, networkAccess: true }, {
        chatId: 'network-denied-test', allowNetwork: false, signal: new AbortController().signal,
      });
      const deniedRow = db.prepare('SELECT input FROM tool_runs WHERE id = ? LIMIT 1').get(denied.runId) as any;
      expect(JSON.parse(deniedRow.input).networkAccess).toBe(false);
      expect(denied.output.stdout).toBe('false');
    } finally { terminalTool.execute = originalExecute; }
  });

  it('serves generated PNGs inline and as downloads through the authenticated media route', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/OQAAAABJRU5ErkJggg==';
    const media = storeGeneratedPng(png);
    const inline = await nativeFetch(`${apiBase}${media.url}`);
    expect(inline.status).toBe(200);
    expect(inline.headers.get('content-type')).toContain('image/png');
    expect(inline.headers.get('content-disposition')).toContain('inline');
    const download = await nativeFetch(`${apiBase}${media.url}?download=1`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('attachment');
    const generatedDir = path.join(tempDir, 'generated-media');
    fs.writeFileSync(path.join(tempDir, 'outside.png'), Buffer.from(png, 'base64'));
    const escapedId = '123e4567-e89b-42d3-a456-426614174000';
    fs.symlinkSync(path.join(tempDir, 'outside.png'), path.join(generatedDir, `${escapedId}.png`));
    const escaped = await nativeFetch(`${apiBase}/api/media/${escapedId}`);
    expect(escaped.status).toBe(404);
  });

  it('only previews safe image/video files whose resolved path stays inside /workspace', async () => {
    const workspace = path.join(tempDir, 'sandbox-workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'sample.mp4'), 'video-bytes');
    const response = await nativeFetch(`${apiBase}/api/terminal/media?path=${encodeURIComponent('/workspace/sample.mp4')}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('video/mp4');
    expect(response.headers.get('content-disposition')).toContain('inline');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    const partial = await nativeFetch(`${apiBase}/api/terminal/media?path=${encodeURIComponent('/workspace/sample.mp4')}`, { headers: { Range: 'bytes=2-5' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe('bytes 2-5/11');
    expect(await partial.text()).toBe('deo-');
    const download = await nativeFetch(`${apiBase}/api/terminal/media?path=${encodeURIComponent('/workspace/sample.mp4')}&download=1`);
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect(openSandboxMediaFile('/workspace/../outside.mp4')).toBeNull();
    fs.writeFileSync(path.join(tempDir, 'outside.mp4'), 'private');
    fs.symlinkSync(path.join(tempDir, 'outside.mp4'), path.join(workspace, 'escape.mp4'));
    expect(openSandboxMediaFile('/workspace/escape.mp4')).toBeNull();
    const directEscape = await nativeFetch(`${apiBase}/api/terminal/media?path=${encodeURIComponent('/workspace/escape.mp4')}`);
    expect(directEscape.status).toBe(404);
    fs.mkdirSync(path.join(tempDir, 'outside-dir'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'outside-dir', 'nested.mp4'), 'private');
    fs.symlinkSync(path.join(tempDir, 'outside-dir'), path.join(workspace, 'escape-dir'));
    expect(openSandboxMediaFile('/workspace/escape-dir/nested.mp4')).toBeNull();
    const nestedEscape = await nativeFetch(`${apiBase}/api/terminal/media?path=${encodeURIComponent('/workspace/escape-dir/nested.mp4')}`);
    expect(nestedEscape.status).toBe(404);
    fs.writeFileSync(path.join(workspace, 'race.mp4'), 'safe-before-swap');
    const pinned = openSandboxMediaFile('/workspace/race.mp4');
    expect(pinned).not.toBeNull();
    fs.unlinkSync(path.join(workspace, 'race.mp4'));
    fs.symlinkSync(path.join(tempDir, 'outside.mp4'), path.join(workspace, 'race.mp4'));
    try { expect(fs.readFileSync(pinned!.fd, 'utf8')).toBe('safe-before-swap'); }
    finally { fs.closeSync(pinned!.fd); }
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

  it('does not call DuckDuckGo after a default Brave Search 429', async () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('workspace.searchBackend', '')").run();
    const visited: string[] = [];
    const result = await executeWebSearch({ query: 'current test', maxResults: 5 }, new AbortController().signal, async (url: URL) => {
      visited.push(url.hostname);
      return { status: 429, headers: { get: name => name === 'retry-after' ? '30' : null }, body: 'private upstream body' };
    });
    expect(visited).toEqual(['search.brave.com']);
    expect(result.error).toContain('HTTP 429');
    expect(result.error).toContain('Try again later');
    expect(result.error).not.toContain('private upstream body');
  });

  it('replaces a legacy saved DuckDuckGo URL with Brave rather than requesting DuckDuckGo', async () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('workspace.searchBackend', ?)").run('https://lite.duckduckgo.com/lite/');
    const visited: string[] = [];
    const result = await executeWebSearch({ query: 'current test', maxResults: 5 }, new AbortController().signal, async (url: URL) => {
      visited.push(url.hostname);
      return { status: 200, headers: { get: name => name === 'content-type' ? 'text/html' : null }, body: '<a href="https://example.com/docs"><div class="title search-snippet-title">Brave result</div></a>' };
    });
    expect(visited).toEqual(['search.brave.com']);
    expect(result.error).toBeUndefined();
    expect(result.output.results[0].title).toBe('Brave result');
  });

  it('discards CAPTCHA challenge HTML and never returns its contents', async () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('workspace.searchBackend', '')").run();
    const challenge = '<html><title>Security check - CAPTCHA</title><div class="g-recaptcha">secret challenge body</div></html>';
    const result = await executeWebSearch({ query: 'current test', maxResults: 5 }, new AbortController().signal, async () => ({
      status: 200,
      headers: { get: name => name === 'content-type' ? 'text/html' : null },
      body: challenge,
    }));
    expect(result.error).toContain('anti-bot or CAPTCHA challenge');
    expect(result.error).toContain('was not sent to the model');
    expect(result.error).not.toContain('secret challenge body');
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

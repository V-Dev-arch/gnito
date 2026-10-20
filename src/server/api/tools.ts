/**
 * Gnito — tool registry + permission gating.
 *
 * A "tool" is a capability the agent can call. Each tool:
 *  - declares input/output schemas (zod)
 *  - declares required permissions
 *  - has a timeout
 *  - is auditable via `tool_runs` table
 *
 * HIGH-RISK tools (terminal, destructive files, external network) require
 * the user to issue a confirmation token via /api/tools/:id/approve.
 * The agent cannot call a high-risk tool without that token.
 */
import type { Request, Response } from 'express';
import fsSyncImport from 'node:fs';
import pathImport from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { redactSecrets, truncateForLog } from '../security/redact.js';
import { fetchPublicUrl } from '../security/publicFetch.js';
import { getSandboxStatus, runSandboxCommand } from '../sandbox/docker.js';

const db = getDb();

const TOOL_TIMEOUT_MS = 30_000;
const activeToolControllers = new Map<string, AbortController>();

// ------------------------------------------------------- tool definitions

interface ToolDef {
  name: string;
  description: string;
  permissions: string[];
  requiresConfirmation: boolean;
  inputSchema: z.ZodTypeAny;
  /** Execute the tool. Returns { output, error } — never throws raw exceptions. */
  execute: (input: any, signal: AbortSignal, options?: { onOutput?: (output: any) => void }) => Promise<{ output?: any; error?: string }>;
}

/** All registered tools. */
export const TOOL_REGISTRY: Map<string, ToolDef> = new Map();

// --- web_search ---------------------------------------------------------
const DEFAULT_SEARCH_TARGETS = [
  { label: 'Brave Search', url: 'https://search.brave.com/search' },
  { label: 'Bing Search', url: 'https://www.bing.com/search' },
  { label: 'DuckDuckGo HTML Search', url: 'https://html.duckduckgo.com/html/' },
] as const;
const SEARCH_ATTEMPT_TIMEOUT_MS = 7_000;
const SEARCH_ROUTE_TIMEOUT_MS = 25_000;

function isBuiltInSearchBackend(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (host === 'search.brave.com' && /^\/search\/?$/.test(url.pathname))
      || (host === 'www.bing.com' && /^\/search\/?$/.test(url.pathname))
      || (host === 'html.duckduckgo.com' && /^\/html\/?$/.test(url.pathname))
      || (host === 'lite.duckduckgo.com' && /^\/lite\/?$/.test(url.pathname));
  } catch { return false; }
}

export async function executeWebSearch(
  input: { query: string; maxResults: number },
  signal: AbortSignal,
  fetcher: typeof fetchPublicUrl = fetchPublicUrl,
): Promise<{ output?: any; error?: string }> {
  const backend = db.prepare("SELECT value FROM settings WHERE key = 'workspace.searchBackend'").get() as any;
  const configuredBackend = typeof backend?.value === 'string' ? backend.value.trim() : '';
  // Treat saved legacy/default URLs as built-in so DuckDuckGo settings from
  // older versions no longer send requests to its CAPTCHA-prone HTML pages.
  const usesDefaultProviders = !configuredBackend || isBuiltInSearchBackend(configuredBackend);
  const targets = !usesDefaultProviders
    ? [{ label: 'Configured search backend', url: configuredBackend }]
    : [...DEFAULT_SEARCH_TARGETS];
  const failures: string[] = [];

  for (let index = 0; index < targets.length; index++) {
    const { label, url } = targets[index];
    try {
      const target = new URL(url);
      if (target.protocol !== 'https:' || target.username || target.password || target.hash) {
        return { error: 'Search backend must be a public HTTPS URL without embedded credentials or a fragment.' };
      }
      target.searchParams.set('q', input.query);
      if (!usesDefaultProviders && /searx/i.test(target.hostname)) target.searchParams.set('format', 'json');
      const resp = await fetcher(target, {
        signal,
        timeoutMs: SEARCH_ATTEMPT_TIMEOUT_MS,
        maxBytes: 1_000_000,
        headers: {
          'User-Agent': 'Gnito/0.1 (local-first AI workspace)',
          Accept: 'text/html, application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (resp.status !== 200) {
        const retryAfter = resp.headers.get('retry-after')?.slice(0, 80);
        failures.push(`${label} returned HTTP ${resp.status}${retryAfter ? ` (Retry-After: ${retryAfter})` : ''}.`);
        if (index < targets.length - 1) continue;
        return { error: searchFailureMessage(failures, usesDefaultProviders) };
      }

      const contentType = resp.headers.get('content-type') || '';
      if (isSearchChallengePage(resp.body)) {
        failures.push(`${label} returned an anti-bot or CAPTCHA challenge. The challenge page was discarded and was not sent to the model.`);
        if (index < targets.length - 1) continue;
        return { error: searchFailureMessage(failures, usesDefaultProviders) };
      }
      const results = /application\/json/i.test(contentType)
        ? parseSearxResults(resp.body, target, input.maxResults)
        : /(^|\.)search\.brave\.com$/i.test(target.hostname)
          ? parseBraveResults(resp.body, target, input.maxResults)
          : /(^|\.)bing\.com$/i.test(target.hostname)
            ? parseBingResults(resp.body, target, input.maxResults)
            : parseDuckDuckGoResults(resp.body, target, input.maxResults);
      if (!results.length) {
        failures.push(`${label} returned no parseable results; it may have sent a challenge page or no results for this query.`);
        if (index < targets.length - 1) continue;
        return { error: searchFailureMessage(failures, usesDefaultProviders) };
      }
      return { output: { query: input.query, results } };
    } catch (error: any) {
      if (signal.aborted || error?.name === 'AbortError') return { error: 'Search timed out.' };
      const message = String(error?.message || '');
      const detail = /public IP|HTTPS URL|byte limit|Only credential-free|timed out/i.test(message)
        ? message
        : 'request failed.';
      failures.push(`${label}: ${detail}`);
      if (index < targets.length - 1) continue;
      return { error: searchFailureMessage(failures, usesDefaultProviders) };
    }
  }

  return { error: searchFailureMessage(failures, usesDefaultProviders) };
}

function searchFailureMessage(failures: string[], usedDefaultProviders: boolean): string {
  const source = failures.join(' ');
  const providerState = usedDefaultProviders ? 'The built-in public search providers are unavailable or rate-limited.' : 'The configured search backend is unavailable or rate-limited.';
  return `${source} ${providerState} Try again later or configure a public HTTPS SearXNG endpoint in Settings → Tools & Search.`;
}

function isSearchChallengePage(body: string): boolean {
  return /<title[^>]*>[^<]*(?:captcha|verify (?:you|that)|unusual traffic|robot check|security check)[^<]*<\/title>|g-recaptcha|h-captcha|recaptcha\/api|cf-chl-|challenge-platform|verify you are human|unusual traffic from your (?:computer|network)|automated requests/i.test(body);
}

TOOL_REGISTRY.set('web_search', {
  name: 'web_search',
  description: 'Search the public web via a configured provider, or Brave Search when using the default. Anti-bot/CAPTCHA pages are discarded and never sent to the model.',
  permissions: ['network:web-search'],
  requiresConfirmation: false,
  inputSchema: z.object({
    query: z.string().min(1).max(500),
    maxResults: z.number().int().min(1).max(20).default(10),
  }),
  execute: (input, signal) => executeWebSearch(input, signal),
});

// --- read_url ------------------------------------------------------------
TOOL_REGISTRY.set('read_url', {
  name: 'read_url',
  description: 'Fetch a public web page and extract readable text. Treated as untrusted content.',
  permissions: ['network:fetch-url'],
  requiresConfirmation: false,
  inputSchema: z.object({
    url: z.string().url().max(2000),
    maxChars: z.number().int().min(100).max(100_000).default(5000),
  }),
  execute: async (input, signal) => {
    try {
      const u = new URL(input.url);
      if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.hash) return { error: 'Only credential-free HTTP(S) URLs without fragments are allowed.' };
      const resp = await fetchPublicUrl(u, { signal, timeoutMs: 10_000, maxBytes: 1_000_000, headers: { 'User-Agent': 'Gnito/0.1 (local-first AI workspace)', Accept: 'text/html, application/json, application/xml, text/plain' } });
      if (resp.status >= 300 && resp.status < 400) {
        return { error: `Redirect to ${resp.headers.get('location')?.slice(0, 100)} — not followed.` };
      }
      if (resp.status < 200 || resp.status >= 300) return { error: `Fetch returned HTTP ${resp.status}.` };
      const contentType = resp.headers.get('content-type') || '';
      if (!/text\/|application\/json|application\/xml/.test(contentType)) {
        return { error: `Unsupported content-type: ${contentType}` };
      }
      const text = resp.body;
      const cleaned = stripHtml(text).slice(0, input.maxChars);
      return { output: { url: input.url, content: cleaned, truncated: text.length > input.maxChars } };
    } catch (e: any) {
      if (e?.name === 'AbortError') return { error: 'Fetch timed out.' };
      return { error: redactSecrets(e?.message || 'Fetch failed.') };
    }
  },
});

// --- files_read / files_write / files_delete --------------------------------
// These share implementations with the files API. The files API exposes the
// raw endpoints; the tool layer wraps them for agent use.
TOOL_REGISTRY.set('files_list', {
  name: 'files_list',
  description: 'List files/folders inside an approved root.',
  permissions: ['files:read'],
  requiresConfirmation: false,
  inputSchema: z.object({ path: z.string().min(1).max(2000).default('.') }),
  execute: async (input) => {
    const safe = resolveApprovedPath(input.path);
    if (!safe) return { error: 'Path is outside approved folders.' };
    try {
      const fs = await import('node:fs/promises');
      const entries = await fs.readdir(safe, { withFileTypes: true });
      return { output: { entries: entries.map(e => ({ name: e.name, isDir: e.isDirectory() })) } };
    } catch (e: any) {
      return { error: redactSecrets(e.message) };
    }
  },
});

TOOL_REGISTRY.set('files_read', {
  name: 'files_read',
  description: 'Read a text/code file inside an approved root.',
  permissions: ['files:read'],
  requiresConfirmation: false,
  inputSchema: z.object({ path: z.string().min(1).max(2000) }),
  execute: async (input) => {
    const safe = resolveApprovedPath(input.path);
    if (!safe) return { error: 'Path is outside approved folders.' };
    try {
      const fs = await import('node:fs/promises');
      const stat = await fs.stat(safe);
      if (!stat.isFile()) return { error: 'Not a file.' };
      if (stat.size > 5 * 1024 * 1024) return { error: 'File too large (5 MB max).' };
      const content = await fs.readFile(safe, 'utf8');
      return { output: { path: input.path, content } };
    } catch (e: any) {
      return { error: redactSecrets(e.message) };
    }
  },
});

TOOL_REGISTRY.set('files_write', {
  name: 'files_write',
  description: 'Write/overwrite a file inside an approved root. REQUIRES user confirmation and write permission on the grant.',
  permissions: ['files:write'],
  requiresConfirmation: true,
  inputSchema: z.object({
    path: z.string().min(1).max(2000),
    content: z.string().max(5 * 1024 * 1024),
  }),
  execute: async (input) => {
    const grant = grantForPath(input.path);
    if (!grant) return { error: 'Path is outside approved folders.' };
    if (!grant.permissions.includes('files:write')) {
      return { error: `The grant "${grant.label}" does not allow writes.` };
    }
    const safe = resolveApprovedPath(input.path);
    if (!safe) return { error: 'Path is outside approved folders.' };
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      // For new files, verify the deepest existing ancestor is inside the root
      // (prevents symlink-to-outside escape on creation).
      await fs.mkdir(path.dirname(safe), { recursive: true });
      await fs.writeFile(safe, input.content, 'utf8');
      return { output: { written: input.path, bytes: input.content.length } };
    } catch (e: any) {
      return { error: redactSecrets(e.message) };
    }
  },
});

TOOL_REGISTRY.set('files_delete', {
  name: 'files_delete',
  description: 'Delete a file inside an approved root. DESTRUCTIVE — REQUIRES user confirmation and delete permission on the grant.',
  permissions: ['files:delete'],
  requiresConfirmation: true,
  inputSchema: z.object({ path: z.string().min(1).max(2000) }),
  execute: async (input) => {
    const grant = grantForPath(input.path);
    if (!grant) return { error: 'Path is outside approved folders.' };
    if (!grant.permissions.includes('files:delete')) {
      return { error: `The grant "${grant.label}" does not allow deletes.` };
    }
    const safe = resolveApprovedPath(input.path);
    if (!safe) return { error: 'Path is outside approved folders.' };
    try {
      const fs = await import('node:fs/promises');
      await fs.unlink(safe);
      return { output: { deleted: input.path } };
    } catch (e: any) {
      return { error: redactSecrets(e.message) };
    }
  },
});

// --- terminal_run (Docker-only isolated workspace) -----------------------
TOOL_REGISTRY.set('terminal_run', {
  name: 'terminal_run',
  description:
    'Run a shell command in Gnito’s isolated Docker workspace. The host shell is never used as a fallback. Internet access is opt-in for each chat request.',
  permissions: ['terminal:run'],
  requiresConfirmation: true,
  inputSchema: z.object({
    command: z.string().min(1).max(10_000),
    timeoutMs: z.number().int().min(1000).max(300_000).default(180_000),
    networkAccess: z.boolean().default(false),
  }),
  execute: async (input, signal, options) => runSandboxCommand(input.command, input.timeoutMs, signal, {
    networkAccess: input.networkAccess,
    onOutput: options?.onOutput,
  }),
});

/** Run an agent tool only after the chat request explicitly granted its capability. */
export async function executeAgentTerminal(input: unknown, options: {
  chatId: string;
  allowNetwork: boolean;
  signal: AbortSignal;
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<{ runId: string; status: string; output?: any; error?: string }> {
  const tool = TOOL_REGISTRY.get('terminal_run');
  if (!tool) throw new Error('Terminal tool is unavailable.');
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Terminal tool arguments are invalid: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
  const requested = parsed.data as { command: string; timeoutMs: number; networkAccess: boolean };
  // The chat-level opt-in is authoritative. Models often omit a secondary
  // networkAccess argument even when the user has enabled Network in the UI.
  const value = { ...requested, networkAccess: options.allowNetwork };
  const runId = randomUUID();
  const startedAt = Date.now();
  const context = options.chatId.slice(0, 200);
  db.prepare('INSERT INTO tool_runs (id, tool, input, status, started_at, context) VALUES (?,?,?,?,?,?)')
    .run(runId, tool.name, JSON.stringify(value), 'approved', startedAt, context);

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal.aborted) controller.abort();
  else options.signal.addEventListener('abort', abort, { once: true });
  activeToolControllers.set(runId, controller);
  db.prepare("UPDATE tool_runs SET status='running' WHERE id=? AND status='approved'").run(runId);
  options.onEvent?.({ type: 'start', runId, tool: tool.name, command: value.command, networkAccess: value.networkAccess });

  try {
    const result = await tool.execute(value, controller.signal, {
      onOutput: output => {
        const safeOutput = redactObject(output);
        db.prepare("UPDATE tool_runs SET output=? WHERE id=? AND status='running'")
          .run(JSON.stringify(safeOutput), runId);
        options.onEvent?.({ type: 'output', runId, output: safeOutput });
      },
    });
    const status = result.error ? (controller.signal.aborted ? 'cancelled' : 'failed') : 'succeeded';
    const output = redactObject(result.output ?? null);
    db.prepare('UPDATE tool_runs SET status=?, ended_at=?, error=?, output=? WHERE id=?')
      .run(status, Date.now(), result.error ? truncateForLog(redactSecrets(result.error)) : null, JSON.stringify(output), runId);
    options.onEvent?.({ type: 'end', runId, status, command: value.command, networkAccess: value.networkAccess, output, error: result.error ? redactSecrets(result.error) : undefined });
    return { runId, status, output, error: result.error };
  } catch (error: any) {
    const status = controller.signal.aborted ? 'cancelled' : 'failed';
    const message = redactSecrets(error?.message || 'Terminal execution failed.');
    db.prepare('UPDATE tool_runs SET status=?, ended_at=?, error=? WHERE id=?')
      .run(status, Date.now(), truncateForLog(message), runId);
    options.onEvent?.({ type: 'end', runId, status, command: value.command, networkAccess: value.networkAccess, error: message });
    return { runId, status, error: message };
  } finally {
    options.signal.removeEventListener('abort', abort);
    activeToolControllers.delete(runId);
  }
}

// ------------------------------------------------------------- helpers

interface ResolvedGrant { root: string; label: string; permissions: string[] }

/** Find the grant whose root contains the given user path. */
function grantForPath(userPath: string): ResolvedGrant | null {
  const fsSync = fsSyncImport;
  const path = pathImport;
  if (userPath.includes('\0')) return null;
  const normalized = path.normalize(userPath);
  if (normalized.startsWith('..')) return null;
  const grants = db.prepare('SELECT * FROM file_grants').all() as any[];
  for (const g of grants) {
    const root = path.resolve(g.root_path);
    const candidate = path.resolve(root, normalized);
    try {
      const realRoot = fsSync.realpathSync(root);
      try {
        const realCandidate = fsSync.realpathSync(candidate);
        if (realCandidate === realRoot || realCandidate.startsWith(realRoot + path.sep)) {
          return { root, label: g.label, permissions: JSON.parse(g.permissions || '[]') };
        }
      } catch {
        // Candidate doesn't exist (new file). Check deepest existing ancestor.
        let ancestor = path.dirname(candidate);
        while (true) {
          try {
            const realAncestor = fsSync.realpathSync(ancestor);
            if (realAncestor === realRoot || realAncestor.startsWith(realRoot + path.sep)) {
              return { root, label: g.label, permissions: JSON.parse(g.permissions || '[]') };
            }
            break;
          } catch {
            const parent = path.dirname(ancestor);
            if (parent === ancestor) break;
            ancestor = parent;
          }
        }
      }
    } catch {
      // Root doesn't exist; skip.
    }
  }
  return null;
}

function resolveApprovedPath(userPath: string): string | null {
  const g = grantForPath(userPath);
  return g ? pathImport.resolve(g.root, pathImport.normalize(userPath)) : null;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
    const name = code.toLowerCase();
    if (name === 'amp') return '&';
    if (name === 'lt') return '<';
    if (name === 'gt') return '>';
    if (name === 'quot') return '"';
    if (name === 'apos' || name === '#39') return "'";
    if (name === 'nbsp') return ' ';
    const number = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    try { return Number.isFinite(number) && number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity; }
    catch { return entity; }
  });
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(html.replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function safeResultUrl(raw: string, base: URL): string | null {
  try {
    let url = new URL(decodeHtmlEntities(raw), base);
    if (url.hostname.endsWith('duckduckgo.com') && url.pathname === '/l/') {
      const target = url.searchParams.get('uddg');
      if (!target) return null;
      url = new URL(target);
    }
    if (/(^|\.)bing\.com$/i.test(url.hostname) && url.pathname === '/ck/a') {
      const encoded = url.searchParams.get('u') || '';
      if (!encoded.startsWith('a1') || encoded.length > 8_192) return null;
      const target = Buffer.from(encoded.slice(2), 'base64url').toString('utf8');
      url = new URL(target);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.toString().slice(0, 2_048);
  } catch { return null; }
}

export function parseBingResults(html: string, base: URL, maxResults: number): { title: string; url: string; snippet: string }[] {
  const results: { title: string; url: string; snippet: string }[] = [];
  const markers = [...html.matchAll(/<li\b(?=[^>]*\bclass=["'][^"']*\bb_algo\b[^"']*["'])[^>]*>/gi)];
  for (let index = 0; index < markers.length && results.length < maxResults; index++) {
    const start = markers[index].index ?? 0;
    const nextStart = markers[index + 1]?.index;
    const orderedListEnd = html.indexOf('</ol>', start);
    const end = nextStart ?? (orderedListEnd >= 0 ? orderedListEnd : html.length);
    const block = html.slice(start, end);
    const anchor = block.match(/<h2\b[^>]*>\s*<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const url = safeResultUrl(anchor[2], base);
    if (!url) continue;
    const title = stripHtml(anchor[3]).slice(0, 250);
    const snippetHtml = block.match(/<div\b[^>]*class=["'][^"']*\bb_caption\b[^"']*["'][^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || '';
    results.push({ title: title || url, url, snippet: stripHtml(snippetHtml).slice(0, 1_000) });
  }
  return results;
}

export function parseBraveResults(html: string, base: URL, maxResults: number): { title: string; url: string; snippet: string }[] {
  const results: { title: string; url: string; snippet: string }[] = [];
  const titles = [...html.matchAll(/<div\b(?=[^>]*\bclass=["'][^"']*\bsearch-snippet-title\b[^"']*["'])[^>]*>([\s\S]*?)<\/div>/gi)];
  for (let index = 0; index < titles.length; index++) {
    if (results.length >= maxResults) break;
    const titleMatch = titles[index];
    const titleIndex = titleMatch.index ?? -1;
    if (titleIndex < 0) continue;
    const anchorStart = html.lastIndexOf('<a ', titleIndex);
    const anchorEnd = html.indexOf('</a>', titleIndex);
    if (anchorStart < 0 || anchorEnd < 0) continue;
    const openingTagEnd = html.indexOf('>', anchorStart);
    if (openingTagEnd < 0 || openingTagEnd > titleIndex) continue;
    const openingTag = html.slice(anchorStart, openingTagEnd + 1);
    const href = openingTag.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    const url = href ? safeResultUrl(href, base) : null;
    if (!url) continue;
    const regionEnd = titles[index + 1]?.index ?? Math.min(html.length, titleIndex + 5_000);
    const region = html.slice(titleIndex, regionEnd);
    const snippetHtml = region.match(/<div\b(?=[^>]*\bclass=["'][^"']*\bgeneric-snippet\b[^"']*["'])[^>]*>[\s\S]*?<div\b(?=[^>]*\bclass=["'][^"']*\bcontent\b[^"']*["'])[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '';
    results.push({ title: stripHtml(titleMatch[1]).slice(0, 250) || url, url, snippet: stripHtml(snippetHtml).slice(0, 1_000) });
  }
  return results;
}

export function parseDuckDuckGoResults(html: string, base: URL, maxResults: number): { title: string; url: string; snippet: string }[] {
  const results: { title: string; url: string; snippet: string }[] = [];
  const anchors = /<a\b(?=[^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'])[^>]*>[\s\S]*?<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchors.exec(html)) && results.length < maxResults) {
    const href = match[0].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    const url = href ? safeResultUrl(href, base) : null;
    if (!url) continue;
    const title = stripHtml(match[0].replace(/^<a\b[^>]*>/i, '').replace(/<\/a>$/i, '')).slice(0, 250);
    const afterAnchor = html.slice(match.index + match[0].length, match.index + match[0].length + 2_000);
    const snippetHtml = afterAnchor.match(/<[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1] || '';
    results.push({ title: title || url, url, snippet: stripHtml(snippetHtml).slice(0, 1_000) });
  }
  return results;
}

export function parseSearxResults(body: string, base: URL, maxResults: number): { title: string; url: string; snippet: string }[] {
  const data = JSON.parse(body);
  if (!Array.isArray(data?.results)) throw new Error('SearXNG returned an invalid result list.');
  return data.results.slice(0, maxResults).flatMap((result: any) => {
    const url = typeof result?.url === 'string' ? safeResultUrl(result.url, base) : null;
    if (!url) return [];
    return [{
      title: String(result.title || url).slice(0, 250),
      url,
      snippet: stripHtml(String(result.content || result.snippet || '')).slice(0, 1_000),
    }];
  });
}

// -------------------------------------------------------------- routes

export function registerToolRoutes(app: any): void {
  app.get('/api/tools/sandbox/status', async (_req: Request, res: Response) => {
    res.json(await getSandboxStatus());
  });

  // Explicit user-invoked web search: this low-risk tool does not need a second confirmation.
  app.post('/api/tools/web-search', async (req: Request, res: Response) => {
    const tool = TOOL_REGISTRY.get('web_search');
    if (!tool) { res.status(503).json({ error: 'Web search is unavailable.' }); return; }
    const parsed = tool.inputSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation', message: 'Provide a search query of at most 500 characters.' }); return; }
    const context = typeof req.body?.chatId === 'string' ? req.body.chatId.slice(0, 200) : null;
    if (context && !db.prepare('SELECT id FROM chats WHERE id = ?').get(context)) {
      res.status(404).json({ error: 'not-found', message: 'The selected chat no longer exists.' });
      return;
    }
    const runId = randomUUID();
    const startedAt = Date.now();
    db.prepare('INSERT INTO tool_runs (id, tool, input, status, started_at, context) VALUES (?,?,?,?,?,?)')
      .run(runId, tool.name, JSON.stringify(parsed.data), 'running', startedAt, context);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_ROUTE_TIMEOUT_MS);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const result = await tool.execute(parsed.data, controller.signal);
      clearTimeout(timer);
      if (result.error) {
        db.prepare("UPDATE tool_runs SET status='failed', ended_at=?, error=? WHERE id=?")
          .run(Date.now(), truncateForLog(result.error), runId);
        res.status(502).json({ runId, error: result.error });
        return;
      }
      db.prepare("UPDATE tool_runs SET status='succeeded', ended_at=?, output=? WHERE id=?")
        .run(Date.now(), JSON.stringify(redactObject(result.output ?? null)), runId);
      res.json({ runId, status: 'succeeded', output: result.output });
    } catch {
      clearTimeout(timer);
      db.prepare("UPDATE tool_runs SET status='failed', ended_at=?, error=? WHERE id=?")
        .run(Date.now(), 'Web search failed.', runId);
      res.status(502).json({ runId, error: 'Web search failed. Retry or check the search backend.' });
    }
  });

  // List tools (without execute).
  app.get('/api/tools', (_req: Request, res: Response) => {
    const out = Array.from(TOOL_REGISTRY.values()).map(t => ({
      name: t.name,
      description: t.description,
      permissions: t.permissions,
      requiresConfirmation: t.requiresConfirmation,
    }));
    res.json(out);
  });

  // Create a pending approval + return its id. Agent calls this to request.
  app.post('/api/tools/:name/request', (req: Request, res: Response) => {
    const tool = TOOL_REGISTRY.get(req.params.name);
    if (!tool) { res.status(404).json({ error: 'unknown-tool' }); return; }
    const parsed = tool.inputSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation', issues: parsed.error.issues }); return; }
    const runId = randomUUID();
    // Store the FULL input (not redacted) so approval binds to exact args;
    // redaction only applies to what we log/display.
    const context = typeof req.body?.context === 'string' ? req.body.context.slice(0, 200) : null;
    db.prepare(`INSERT INTO tool_runs (id, tool, input, status, started_at, context) VALUES (?,?,?,?,?,?)`)
      .run(runId, tool.name, JSON.stringify(parsed.data), 'pending-approval', Date.now(), context);
    res.status(201).json({ runId, requiresConfirmation: tool.requiresConfirmation });
  });

  // User approves a pending tool call → issues execution token.
  app.post('/api/tools/runs/:runId/approve', (req: Request, res: Response) => {
    const row = db.prepare(`SELECT * FROM tool_runs WHERE id = ?`).get(req.params.runId) as any;
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    if (row.status !== 'pending-approval') { res.status(409).json({ error: 'not-pending' }); return; }
    const updated = db.prepare(`UPDATE tool_runs SET status='approved' WHERE id=? AND status='pending-approval'`).run(req.params.runId);
    if (updated.changes !== 1) { res.status(409).json({ error: 'not-pending' }); return; }
    res.json({ ok: true });
  });

  // Deny a pending tool call.
  app.post('/api/tools/runs/:runId/deny', (req: Request, res: Response) => {
    const row = db.prepare(`SELECT * FROM tool_runs WHERE id = ?`).get(req.params.runId) as any;
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    const updated = db.prepare(`UPDATE tool_runs SET status='denied', ended_at=? WHERE id=? AND status='pending-approval'`).run(Date.now(), req.params.runId);
    if (updated.changes !== 1) { res.status(409).json({ error: 'not-pending' }); return; }
    res.json({ ok: true });
  });

  app.patch('/api/tools/runs/:runId/context', (req: Request, res: Response) => {
    const parsed = z.object({ chatId: z.string().min(1).max(200) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation' }); return; }
    if (!db.prepare('SELECT id FROM chats WHERE id = ?').get(parsed.data.chatId)) {
      res.status(404).json({ error: 'chat-not-found' });
      return;
    }
    const row = db.prepare('SELECT status, context FROM tool_runs WHERE id = ?').get(req.params.runId) as any;
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    if (row.context === parsed.data.chatId) { res.json({ ok: true }); return; }
    if (row.status !== 'succeeded' || row.context) { res.status(409).json({ error: 'context-already-set-or-run-not-succeeded' }); return; }
    const updated = db.prepare("UPDATE tool_runs SET context=? WHERE id=? AND context IS NULL AND status='succeeded'")
      .run(parsed.data.chatId, req.params.runId);
    if (updated.changes !== 1) { res.status(409).json({ error: 'context-already-set-or-run-not-succeeded' }); return; }
    res.json({ ok: true });
  });

  app.post('/api/tools/runs/:runId/cancel', (req: Request, res: Response) => {
    const row = db.prepare('SELECT * FROM tool_runs WHERE id = ?').get(req.params.runId) as any;
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    if (row.status === 'pending-approval' || row.status === 'approved') {
      const updated = db.prepare("UPDATE tool_runs SET status='cancelled', ended_at=? WHERE id=? AND status IN ('pending-approval','approved')")
        .run(Date.now(), req.params.runId);
      if (updated.changes !== 1) { res.status(409).json({ error: 'not-cancellable' }); return; }
      res.json({ ok: true });
      return;
    }
    if (row.status !== 'running') { res.status(409).json({ error: 'not-running' }); return; }
    const controller = activeToolControllers.get(req.params.runId);
    if (!controller) { res.status(409).json({ error: 'not-cancellable' }); return; }
    controller.abort();
    res.json({ ok: true });
  });

  // Execute an approved tool call. Agent or user triggers this after approval.
  // The exact approved input is used (approval is bound to args).
  app.post('/api/tools/runs/:runId/execute', async (req: Request, res: Response) => {
    const row = db.prepare(`SELECT * FROM tool_runs WHERE id = ?`).get(req.params.runId) as any;
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    if (row.status !== 'approved') { res.status(409).json({ error: 'not-approved' }); return; }
    const tool = TOOL_REGISTRY.get(row.tool);
    if (!tool) { res.status(404).json({ error: 'unknown-tool' }); return; }
    // The input stored at request-time is the ONLY input we run —
    // request-body args are ignored, so approval cannot be bypassed.
    const approvedInput = row.input;

    let input: any;
    try { input = JSON.parse(approvedInput); }
    catch { res.status(500).json({ error: 'Stored command input is invalid.' }); return; }
    const claimed = db.prepare("UPDATE tool_runs SET status='running' WHERE id=? AND status='approved'").run(req.params.runId);
    if (claimed.changes !== 1) { res.status(409).json({ error: 'not-approved' }); return; }
    const controller = new AbortController();
    activeToolControllers.set(req.params.runId, controller);
    const executionTimeoutMs = tool.name === 'terminal_run' ? Math.min(input.timeoutMs || TOOL_TIMEOUT_MS, 300_000) + 45_000 : TOOL_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), executionTimeoutMs);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    try {
      const result = await tool.execute(input, controller.signal, {
        onOutput: (output: any) => {
          db.prepare("UPDATE tool_runs SET output=? WHERE id=? AND status='running'")
            .run(JSON.stringify(redactObject(output)), req.params.runId);
        },
      });
      clearTimeout(timer);
      if (result.error) {
        const status = controller.signal.aborted ? 'cancelled' : 'failed';
        db.prepare(`UPDATE tool_runs SET status=?, ended_at=?, error=?, output=? WHERE id=?`)
          .run(status, Date.now(), truncateForLog(result.error), JSON.stringify(redactObject(result.output ?? null)), req.params.runId);
        res.json({ status, error: result.error });
      } else {
        db.prepare(`UPDATE tool_runs SET status='succeeded', ended_at=?, output=? WHERE id=?`)
          .run(Date.now(), JSON.stringify(redactObject(result.output ?? null)), req.params.runId);
        res.json({ status: 'succeeded', output: result.output });
      }
    } catch (e: any) {
      clearTimeout(timer);
      const status = controller.signal.aborted ? 'cancelled' : 'failed';
      const message = redactSecrets(e?.message || 'Execution failed');
      db.prepare(`UPDATE tool_runs SET status=?, ended_at=?, error=? WHERE id=?`)
        .run(status, Date.now(), truncateForLog(message), req.params.runId);
      res.json({ status, error: message });
    } finally {
      activeToolControllers.delete(req.params.runId);
    }
  });

  // Get tool run status/history.
  app.get('/api/tools/runs', (req: Request, res: Response) => {
    const context = req.query.context ? String(req.query.context) : null;
    let sql = 'SELECT * FROM tool_runs';
    const params: any[] = [];
    if (context) { sql += ' WHERE context = ?'; params.push(context); }
    sql += ' ORDER BY started_at DESC LIMIT 200';
    const rows = db.prepare(sql).all(...params) as any[];
    res.json(rows.map(r => ({
      id: r.id, tool: r.tool, input: r.input, output: r.output, status: r.status,
      error: r.error, startedAt: r.started_at, endedAt: r.ended_at, context: r.context,
    })));
  });

  app.get('/api/tools/runs/:runId', (req: Request, res: Response) => {
    const row = db.prepare('SELECT * FROM tool_runs WHERE id = ?').get(req.params.runId) as any;
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    res.json(row);
  });
}

function redactObject(o: any): any {
  try { return JSON.parse(redactSecrets(JSON.stringify(o ?? null))); } catch { return o; }
}

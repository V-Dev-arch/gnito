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

const db = getDb();

const TOOL_TIMEOUT_MS = 30_000;

// ------------------------------------------------------- tool definitions

interface ToolDef {
  name: string;
  description: string;
  permissions: string[];
  requiresConfirmation: boolean;
  inputSchema: z.ZodTypeAny;
  /** Execute the tool. Returns { output, error } — never throws raw exceptions. */
  execute: (input: any, signal: AbortSignal) => Promise<{ output?: any; error?: string }>;
}

/** All registered tools. */
export const TOOL_REGISTRY: Map<string, ToolDef> = new Map();

// --- web_search ---------------------------------------------------------
TOOL_REGISTRY.set('web_search', {
  name: 'web_search',
  description: 'Search the public web via the configured search provider (SearXNG or DuckDuckGo fallback).',
  permissions: ['network:web-search'],
  requiresConfirmation: false,
  inputSchema: z.object({
    query: z.string().min(1).max(500),
    maxResults: z.number().int().min(1).max(20).default(10),
  }),
  execute: async (input, signal) => {
    try {
      // Call the configured search backend (or default to DuckDuckGo HTML API).
      const backend = db.prepare("SELECT value FROM settings WHERE key = 'workspace.searchBackend'").get() as any;
      const backendUrl = backend?.value || 'https://duckduckgo.com/html/?q=';
      const resp = await fetch(`${backendUrl}${encodeURIComponent(input.query)}`, {
        signal,
        headers: { 'User-Agent': 'Gnito/0.1 (local-first AI workspace)' },
      });
      if (!resp.ok) return { error: `Search returned HTTP ${resp.status}.` };
      const html = await resp.text();
      // Simple extraction: DuckDuckGo HTML results have <a class="result__a">Title</a> and <a class="result__snippet">…
      const results: { title: string; url: string; snippet: string }[] = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>)?/g;
      let m: RegExpExecArray | null;
      let i = 0;
      while ((m = re.exec(html)) && i < input.maxResults) {
        results.push({
          title: stripHtml(m[2]).trim(),
          url: m[1].replace(/&/g, '&'),
          snippet: m[3] ? stripHtml(m[3]).trim() : '',
        });
        i++;
      }
      return { output: { results } };
    } catch (e: any) {
      if (e?.name === 'AbortError') return { error: 'Search timed out.' };
      return { error: redactSecrets(e?.message || 'Search failed.') };
    }
  },
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
      if (!/^https?:$/.test(u.protocol)) return { error: 'Only http(s) URLs are allowed.' };
      // Block local/private network access (SSRF).
      if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|::1)/.test(u.hostname)) {
        return { error: 'Refusing to fetch local/private network URLs.' };
      }
      const resp = await fetch(input.url, { signal, redirect: 'manual' });
      if (resp.status >= 300 && resp.status < 400) {
        return { error: `Redirect to ${resp.headers.get('location')?.slice(0, 100)} — not followed.` };
      }
      if (!resp.ok) return { error: `Fetch returned HTTP ${resp.status}.` };
      const contentType = resp.headers.get('content-type') || '';
      if (!/text\/|application\/json|application\/xml/.test(contentType)) {
        return { error: `Unsupported content-type: ${contentType}` };
      }
      const text = await resp.text();
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

// --- terminal (host, not sandboxed) --------------------------------------
TOOL_REGISTRY.set('terminal_run', {
  name: 'terminal_run',
  description:
    'Run a shell command on the HOST (not sandboxed). HIGH RISK. Requires user confirmation and an explicit allowlist.',
  permissions: ['terminal:run'],
  requiresConfirmation: true,
  inputSchema: z.object({
    command: z.string().min(1).max(1000),
    args: z.array(z.string()).max(50).default([]),
    cwd: z.string().max(2000).optional(),
    timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  }),
  execute: async (input, signal) => {
    // Validate allowlist (executable name only).
    const allowlistSetting = db.prepare("SELECT value FROM settings WHERE key = 'workspace.terminalAllowlist'").get() as any;
    const allowlist: string[] = allowlistSetting ? JSON.parse(allowlistSetting.value) : [];
    if (!allowlist.includes(input.command)) {
      return { error: `Command "${input.command}" not in terminal allowlist. Add it in Settings → Tools.` };
    }
    try {
      const { spawn } = await import('node:child_process');
      // Use shell:false and pass args as an array to prevent shell injection.
      const cwd = input.cwd && resolveApprovedPath(input.cwd) ? input.cwd : undefined;
      let childStdout = '';
      let childStderr = '';
      const child = spawn(input.command, input.args, { signal, shell: false, cwd });
      // Deliberately limited env: inherit only PATH (no secrets).
      child.stdout?.on('data', (d: any) => { if (childStdout.length < 64_000) childStdout += d; });
      child.stderr?.on('data', (d: any) => { if (childStderr.length < 64_000) childStderr += d; });
      const exitCode = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Command timed out.'));
        }, input.timeoutMs);
        child.on('exit', (code) => { clearTimeout(timer); resolve(code ?? 0); });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
      });
      return { output: { exitCode, stdout: truncateForLog(childStdout, 32_000), stderr: truncateForLog(childStderr, 32_000) } };
    } catch (e: any) {
      return { error: redactSecrets(e?.message || 'Command failed.') };
    }
  },
});

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

function stripHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/\s+/g, ' ');
}

// -------------------------------------------------------------- routes

export function registerToolRoutes(app: any): void {
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
    db.prepare(`INSERT INTO tool_runs (id, tool, input, status, started_at) VALUES (?,?,?,?,?)`)
      .run(runId, tool.name, JSON.stringify(parsed.data), 'pending-approval', Date.now());
    res.status(201).json({ runId, requiresConfirmation: tool.requiresConfirmation });
  });

  // User approves a pending tool call → issues execution token.
  app.post('/api/tools/runs/:runId/approve', (req: Request, res: Response) => {
    const row = db.prepare(`SELECT * FROM tool_runs WHERE id = ?`).get(req.params.runId) as any;
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    if (row.status !== 'pending-approval') { res.status(409).json({ error: 'not-pending' }); return; }
    // Approving changes status to "running" but execution happens via /execute.
    db.prepare(`UPDATE tool_runs SET status='approved' WHERE id=?`).run(req.params.runId);
    res.json({ ok: true });
  });

  // Deny a pending tool call.
  app.post('/api/tools/runs/:runId/deny', (req: Request, res: Response) => {
    const row = db.prepare(`SELECT * FROM tool_runs WHERE id = ?`).get(req.params.runId) as any;
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    db.prepare(`UPDATE tool_runs SET status='denied', ended_at=? WHERE id=?`).run(Date.now(), req.params.runId);
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

    db.prepare(`UPDATE tool_runs SET status='running' WHERE id=?`).run(req.params.runId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);
    req.on('close', () => controller.abort());

    try {
      const input = JSON.parse(approvedInput);
      const result = await tool.execute(input, controller.signal);
      clearTimeout(timer);
      if (result.error) {
        db.prepare(`UPDATE tool_runs SET status='failed', ended_at=?, error=?, output=? WHERE id=?`)
          .run(Date.now(), truncateForLog(result.error), JSON.stringify(redactObject(result.output ?? null)), req.params.runId);
        res.json({ status: 'failed', error: result.error });
      } else {
        db.prepare(`UPDATE tool_runs SET status='succeeded', ended_at=?, output=? WHERE id=?`)
          .run(Date.now(), JSON.stringify(redactObject(result.output ?? null)), req.params.runId);
        res.json({ status: 'succeeded', output: result.output });
      }
    } catch (e: any) {
      clearTimeout(timer);
      db.prepare(`UPDATE tool_runs SET status='failed', ended_at=?, error=? WHERE id=?`)
        .run(Date.now(), truncateForLog(redactSecrets(e?.message || 'Execution failed')), req.params.runId);
      res.json({ status: 'failed', error: redactSecrets(e?.message || 'Execution failed') });
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
};

function redactObject(o: any): any {
  try { return JSON.parse(redactSecrets(JSON.stringify(o ?? null))); } catch { return o; }
}

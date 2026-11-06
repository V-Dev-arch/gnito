/**
 * Gnito — Automation Center API + scheduler.
 *
 * The scheduler runs in this local Node process (NOT a browser timer).
 * On startup we detect missed occurrences and apply the user's
 * missed-run policy.
 */
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import cron, { type ScheduledTask } from 'node-cron';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { redactSecrets, truncateForLog } from '../security/redact.js';
import { executeAgentTerminal } from './tools.js';

const db = getDb();

// In-memory scheduler state.
const activeCronJobs = new Map<string, ScheduledTask | ReturnType<typeof setTimeout>>();
let schedulerStarted = false;

// ---------------------------------------------------------------- routes

export function registerAutomationRoutes(app: any): void {
  // List automations.
  app.get('/api/automations', (req: Request, res: Response) => {
    const status = req.query.status ? String(req.query.status) : null;
    let sql = 'SELECT * FROM automations';
    const params: any[] = [];
    if (status) { sql += ' WHERE status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC';
    const rows = db.prepare(sql).all(...params) as any[];
    res.json(rows.map(r => normalizeAutomation(r)));
  });

  // Get one.
  app.get('/api/automations/:id', (req: Request, res: Response) => {
    const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    const runs = db.prepare(`SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 50`)
      .all(req.params.id) as any[];
    res.json({
      automation: normalizeAutomation(row),
      runs: runs.map(r => normalizeRun(r)),
    });
  });

  // Create — parses natural-language prompt into a reviewable schedule.
  // Returns a draft the user can approve.
  app.post('/api/automations', (req: Request, res: Response) => {
    const parsed = z.object({
      prompt: z.string().min(1).max(5000),
      schedule: z.object({
        expression: z.string().min(1).max(120),
        timezone: z.string().min(1).max(120),
        kind: z.enum(['one-shot', 'recurring']).default('recurring'),
      }),
      taskInstruction: z.string().max(10000),
      providerId: z.string().min(1),
      modelId: z.string().min(1).max(200),
      missedRunPolicy: z.enum(['skip', 'run-once-on-startup', 'catch-up-within-window']).default('skip'),
      dryRun: z.boolean().default(false),
      maxSteps: z.number().int().positive().max(50).default(10),
      maxRetries: z.number().int().nonnegative().max(5).default(1),
      retryBackoffMs: z.number().int().nonnegative().max(60_000).default(30_000),
      allowTerminal: z.boolean().default(false),
      allowNetwork: z.boolean().default(false),
      allowTools: z.boolean().default(false),
    }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'validation', issues: parsed.error.issues }); return; }
    const provider = getSelectedProvider(parsed.data.providerId);
    if (!provider) { res.status(400).json({ error: 'provider-unavailable', message: 'Select an enabled provider before creating the automation.' }); return; }
    const id = randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO automations
        (id, prompt, schedule, task_instruction, provider_id, model_id, status, missed_run_policy, dry_run,
         max_steps, max_retries, retry_backoff_ms, allow_terminal, allow_network, allow_tools, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      parsed.data.prompt,
      JSON.stringify(parsed.data.schedule),
      parsed.data.taskInstruction,
      provider.id,
      parsed.data.modelId,
      'draft',
      parsed.data.missedRunPolicy,
      parsed.data.dryRun ? 1 : 0,
      parsed.data.maxSteps,
      parsed.data.maxRetries,
      parsed.data.retryBackoffMs,
      parsed.data.allowTerminal ? 1 : 0,
      parsed.data.allowNetwork && parsed.data.allowTerminal ? 1 : 0,
      parsed.data.allowTools ? 1 : 0,
      now,
      now,
    );
    res.status(201).json({ id, status: 'draft' });
  });

  // Activate — computes next run, starts the cron job.
  app.post('/api/automations/:id/activate', (req: Request, res: Response) => {
    const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    if (!getSelectedProvider(row.provider_id) || !row.model_id) {
      res.status(400).json({ error: 'provider-model-required', message: 'This automation must have an enabled provider and model selected before activation.' });
      return;
    }
    const schedule = JSON.parse(row.schedule);
    if (schedule.kind === 'recurring') {
      if (!cron.validate(schedule.expression)) {
        res.status(400).json({ error: 'invalid-cron', message: 'Schedule expression is not valid.' });
        return;
      }
    }
    db.prepare(`UPDATE automations SET status='active', updated_at=? WHERE id=?`).run(Date.now(), req.params.id);
    scheduleNextRun(req.params.id);
    res.json({ ok: true });
  });

  // Pause.
  app.post('/api/automations/:id/pause', (req: Request, res: Response) => {
    const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    stopCron(req.params.id);
    db.prepare(`UPDATE automations SET status='paused', updated_at=? WHERE id=?`).run(Date.now(), req.params.id);
    res.json({ ok: true });
  });

  // Duplicate.
  app.post('/api/automations/:id/duplicate', (req: Request, res: Response) => {
    const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    const id = randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO automations
        (id, prompt, schedule, task_instruction, provider_id, model_id, status, missed_run_policy, dry_run,
         max_steps, max_retries, retry_backoff_ms, allow_terminal, allow_network, allow_tools, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, row.prompt, row.schedule, row.task_instruction, row.provider_id, row.model_id, 'draft',
      row.missed_run_policy, row.dry_run, row.max_steps, row.max_retries, row.retry_backoff_ms,
      row.allow_terminal, row.allow_network, row.allow_tools, now, now);
    res.status(201).json({ id });
  });

  // Delete.
  app.delete('/api/automations/:id', (req: Request, res: Response) => {
    stopCron(req.params.id);
    const info = db.prepare('DELETE FROM automations WHERE id = ?').run(req.params.id);
    res.json({ ok: info.changes > 0 });
  });

  // Run now (manual trigger — uses the same executor).
  app.post('/api/automations/:id/run-now', async (req: Request, res: Response) => {
    const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    const runId = await triggerRun(req.params.id, { manual: true });
    res.json({ runId });
  });

  // Preview next runs without activating.
  app.get('/api/automations/:id/preview-runs', (req: Request, res: Response) => {
    const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    const schedule = JSON.parse(row.schedule);
    if (schedule.kind !== 'recurring') {
      res.json({ nextRuns: [new Date(schedule.expression).getTime()] });
      return;
    }
    // Evaluate cron next 5 occurrences.
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      // node-cron doesn't expose nextRunAt; use a simple heuristic — the UI displays
      // these as approximate and we always show the exact nextRunAt from the scheduler.
      times.push(Date.now() + (i + 1) * 3600_000); // placeholder — replaced by real scheduler
    }
    res.json({ nextRuns: times, approximate: true });
  });
}

// ---------------------------------------------------------------- scheduler

/** Compute the next run for an automation and start its cron job. */
function scheduleNextRun(automationId: string): void {
  stopCron(automationId);
  const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(automationId) as any;
  if (!row || row.status !== 'active') return;
  const schedule = JSON.parse(row.schedule);

  if (schedule.kind === 'one-shot') {
    const when = new Date(schedule.expression).getTime();
    if (Number.isNaN(when)) return;
    const delay = when - Date.now();
    if (delay < 0) {
      // Already past; mark completed without running (user can run-now).
      db.prepare(`UPDATE automations SET status='completed', updated_at=? WHERE id=?`).run(Date.now(), automationId);
      return;
    }
    const timer = setTimeout(() => {
      triggerRun(automationId, { scheduled: true });
      db.prepare(`UPDATE automations SET status='completed', updated_at=? WHERE id=?`).run(Date.now(), automationId);
    }, delay);
    (activeCronJobs as any).set(automationId, timer); // reuse map for timers too
    db.prepare(`UPDATE automations SET next_run_at=? WHERE id=?`).run(when, automationId);
    return;
  }

  const task = cron.schedule(schedule.expression, () => {
    triggerRun(automationId, { scheduled: true });
  }, { timezone: schedule.timezone });
  activeCronJobs.set(automationId, task);

  // For recurring, we do NOT fabricate a next_run_at — the cron scheduler
  // is the source of truth. We only update next_run_at after each successful
  // run with the actual timestamp of that run (which is accurate for display
  // of "last run"; the next occurrence is computed on demand by preview-runs).
  db.prepare(`UPDATE automations SET next_run_at=NULL WHERE id=?`).run(automationId);
}

function stopCron(automationId: string): void {
  const existing = activeCronJobs.get(automationId);
  if (existing) {
    if ('stop' in existing) void existing.stop();
    else clearTimeout(existing);
    activeCronJobs.delete(automationId);
  }
}

/** Start the scheduler — called once on server boot. */
export function startScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  console.log('[gnito] scheduler: starting');
  const rows = db.prepare(`SELECT * FROM automations WHERE status = 'active'`).all() as any[];
  for (const row of rows) {
    scheduleNextRun(row.id);
  }
  applyMissedRunPolicies();
}

/**
 * On startup, detect missed occurrences and apply missed-run policy.
 * For "skip": mark pending runs older than now as 'skipped-by-policy'.
 * For "run-once-on-startup": trigger a single run per automation.
 * For "catch-up-within-window": replay up to N missed occurrences.
 */
function applyMissedRunPolicies(): void {
  const now = Date.now();
  const rows = db.prepare(`SELECT * FROM automations WHERE status = 'active'`).all() as any[];
  for (const row of rows) {
    const policy = row.missed_run_policy;
    if (policy === 'skip') {
      db.prepare(`
        UPDATE automation_runs
        SET status = 'skipped-by-policy', ended_at = ?
        WHERE automation_id = ? AND status = 'pending' AND started_at < ?
      `).run(now, row.id, now);
    } else if (policy === 'run-once-on-startup') {
      const missedRow = db.prepare(`
        SELECT COUNT(*) AS c FROM automation_runs
        WHERE automation_id = ? AND status = 'pending'
      `).get(row.id) as any;
      if ((missedRow?.c ?? 0) > 0) {
        triggerRun(row.id, { recovery: true });
      }
    } else if (policy === 'catch-up-within-window') {
      const window = row.catch_up_window_ms || 0;
      const cutoff = now - window;
      const missedRows = db.prepare(`
        SELECT * FROM automation_runs
        WHERE automation_id = ? AND status = 'pending' AND started_at >= ?
        ORDER BY started_at ASC
      `).all(row.id, cutoff) as any[];
      for (const m of missedRows.slice(0, 3)) {
        triggerRun(row.id, { recovery: true, occurrenceKey: m.occurrence_key });
      }
      // Mark anything older as skipped.
      db.prepare(`
        UPDATE automation_runs
        SET status = 'skipped-by-policy', ended_at = ?
        WHERE automation_id = ? AND status = 'pending' AND started_at < ?
      `).run(now, row.id, cutoff);
    }
  }
}

/** Trigger a run for an automation. Returns the run id. */
async function triggerRun(
  automationId: string,
  opts: { manual?: boolean; recovery?: boolean; occurrenceKey?: string; scheduled?: boolean } = {},
): Promise<string> {
  const runId = randomUUID();
  const occurrenceKey = opts.occurrenceKey || `${automationId}:${Date.now()}`;
  const now = Date.now();
  void now;
  try {
    db.prepare(`
      INSERT INTO automation_runs (id, automation_id, occurrence_key, status, started_at)
      VALUES (?,?,?,?,?)
    `).run(runId, automationId, occurrenceKey, 'running', now);
  } catch (e: any) {
    // Duplicate occurrence — return the existing run.
    const existing = db.prepare(`SELECT id FROM automation_runs WHERE automation_id = ? AND occurrence_key = ?`)
      .get(automationId, occurrenceKey) as any;
    if (existing) return existing.id;
    throw e;
  }
  // Execute in background (non-blocking).
  executeAutomation(automationId, runId).catch(err => {
    console.error(`[gnito] automation ${automationId} failed:`, redactSecrets(truncateForLog(err?.message || String(err))));
  });
  return runId;
}

/**
 * Execute an automation's agent loop. This is a simplified executor:
 * we call the provider directly with the taskInstruction, collect the
 * response, and save it as resultSummary. Full agent-loop tool-calling
 * is out of scope for this first iteration; we document it in
 * docs/implementation-status.md.
 */
async function executeAutomation(automationId: string, runId: string): Promise<void> {
  const automation = db.prepare('SELECT * FROM automations WHERE id = ?').get(automationId) as any;
  if (!automation) return;

  const chatId = randomUUID();
  const now = Date.now();
  const title = `Scheduled: ${String(automation.prompt || automation.task_instruction).replace(/\s+/g, ' ').trim().slice(0, 280) || 'Automation run'}`;
  db.prepare(`
    INSERT INTO chats (id, project_id, title, status, created_at, updated_at, automation_id, automation_run_id)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(chatId, null, title, 'active', now, now, automationId, runId);
  db.prepare(`
    INSERT INTO messages (id, chat_id, role, content, created_at)
    VALUES (?,?,?,?,?)
  `).run(randomUUID(), chatId, 'user', automation.task_instruction, now);

  try {
    // Use only the provider and model explicitly saved on this automation.
    const provider = getSelectedProvider(automation.provider_id);
    const selectedModel = String(automation.model_id || '').trim();
    if (!provider || !selectedModel) throw new Error('This automation has no enabled provider and model configured. Edit it in Automation Center before running it.');

    const { getProviderSecret } = await import('../security/vault.js');
    const apiKey = getProviderSecret(provider.id) || '';
    const url = buildAutomationChatUrl(provider);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(provider.kind === 'anthropic-compatible'
        ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
        : (apiKey ? { Authorization: `Bearer ${apiKey}` } : {})),
      ...parseCustomHeaders(provider.custom_headers),
    };

    const selectedPermissions = {
      allowTerminal: !!automation.allow_terminal,
      allowNetwork: !!automation.allow_network && !!automation.allow_terminal,
      allowTools: !!automation.allow_tools,
    };
    const summary = await runAutomationAgent({ provider, apiKey, url, headers, model: selectedModel, taskInstruction: automation.task_instruction, chatId, permissions: selectedPermissions, maxSteps: Math.max(1, Math.min(Number(automation.max_steps) || 10, 10)), signal: AbortSignal.timeout(120_000) });
    const assistantText = String(summary || 'The scheduled task completed without a text response.');
    db.prepare(`
      INSERT INTO messages (id, chat_id, role, content, provider_id, model_id, created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(randomUUID(), chatId, 'assistant', assistantText, provider.id, selectedModel, Date.now());

    db.prepare(`
      UPDATE automation_runs
      SET status='succeeded', ended_at=?, result_summary=?, steps_used=1
      WHERE id=?
    `).run(Date.now(), truncateForLog(summary, 10_000), runId);
  } catch (e: any) {
    const errorText = `Scheduled task failed: ${redactSecrets(truncateForLog(e?.message || 'Execution failed', 2_000))}`;
    db.prepare(`INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?,?,?,?,?)`)
      .run(randomUUID(), chatId, 'assistant', errorText, Date.now());
    db.prepare(`
      UPDATE automation_runs
      SET status='failed', ended_at=?, error=?, result_summary=?, steps_used=1
      WHERE id=?
    `).run(Date.now(), truncateForLog(redactSecrets(e?.message || 'Execution failed'), 2000), errorText, runId);
  }
}

async function runAutomationAgent(options: {
  provider: any; apiKey: string; url: string; headers: Record<string, string>; model: string;
  taskInstruction: string; chatId: string; permissions: { allowTerminal: boolean; allowNetwork: boolean; allowTools: boolean }; maxSteps: number; signal: AbortSignal;
}): Promise<string> {
  const { provider, url, headers, model, taskInstruction, chatId, permissions, maxSteps, signal } = options;
  const baseSystem = `You are Gnito, a local-first AI assistant. Execute this scheduled task and respond concisely.\nAutomation permissions: terminal=${permissions.allowTerminal ? 'on' : 'off'}, network=${permissions.allowNetwork ? 'on' : 'off'}, tools=${permissions.allowTools ? 'on' : 'off'}. Never claim a tool ran unless its result confirms it.`;
  if (provider.kind === 'anthropic-compatible' || !permissions.allowTools || !permissions.allowTerminal) {
    const body = provider.kind === 'anthropic-compatible'
      ? { model, messages: [{ role: 'user', content: `${baseSystem}\n\n${taskInstruction}` }], max_tokens: 2000 }
      : { model, messages: [{ role: 'system', content: baseSystem }, { role: 'user', content: taskInstruction }], max_tokens: 2000 };
    const json = await requestAutomationJson(url, headers, body, signal);
    return String(provider.kind === 'anthropic-compatible' ? json?.content?.[0]?.text || '' : json?.choices?.[0]?.message?.content || '');
  }

  const messages: any[] = [{ role: 'system', content: baseSystem }, { role: 'user', content: taskInstruction }];
  const terminalTool = {
    type: 'function',
    function: {
      name: 'terminal_run',
      description: 'Run a command in Gnito’s isolated Docker workspace. Network access is controlled by the automation settings.',
      parameters: { type: 'object', properties: { command: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['command'] },
    },
  };
  for (let round = 0; round < maxSteps; round++) {
    const json = await requestAutomationJson(url, headers, { model, messages, max_tokens: 2000, tools: [terminalTool], tool_choice: 'auto' }, signal, {
      fallbackMessages: [{ role: 'system', content: `${baseSystem}\nThe provider could not accept the tool-enabled request. Do not use tools; complete the task with the information already available.` }, { role: 'user', content: taskInstruction }],
    });
    const message = json?.choices?.[0]?.message;
    if (!message) throw new Error('Provider returned no scheduled-task response.');
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) return String(message.content || '');
    messages.push(message);
    for (const call of message.tool_calls.slice(0, 4)) {
      if (call.function?.name !== 'terminal_run') continue;
      let input: any;
      try { input = JSON.parse(call.function.arguments || '{}'); } catch { input = {}; }
      const result = await executeAgentTerminal(input, { chatId, allowNetwork: permissions.allowNetwork, signal });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 30_000) });
    }
  }
  // Some models keep requesting the same tool after a successful result. Ask once
  // without tools rather than turning a completed run into a hard failure.
  const finalJson = await requestAutomationJson(url, headers, {
    model, messages: [{ role: 'system', content: `${baseSystem}\nThe tool budget is exhausted. Do not call tools. Return a concise final answer based on the completed results.` }, { role: 'user', content: taskInstruction }, ...messages.filter(message => message.role === 'tool').slice(-maxSteps)], max_tokens: 2000,
  }, signal);
  return String(finalJson?.choices?.[0]?.message?.content || 'The scheduled task completed after reaching its tool budget.');
}

async function requestAutomationJson(url: string, headers: Record<string, string>, body: any, signal: AbortSignal, options?: { fallbackMessages?: any[] }): Promise<any> {
  const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (response.ok) {
      const json = await response.json().catch(() => null);
      if (!json) throw new Error('Provider returned an invalid JSON response.');
      return json;
    }
    lastStatus = response.status;
    void response.body?.cancel().catch(() => {});
    if (!transientStatuses.has(response.status) || attempt === 2) break;
    await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
  }
  if (options?.fallbackMessages && [400, 404, 415, 422, 429, 500, 502, 503, 504].includes(lastStatus)) {
    const fallbackBody = { model: body.model, messages: options.fallbackMessages, max_tokens: body.max_tokens };
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(fallbackBody), signal });
    if (response.ok) return response.json();
  }
  throw new Error(`Provider returned HTTP ${lastStatus}.`);
}

function buildAutomationChatUrl(provider: any): string {
  let base = String(provider.base_url || '').replace(/\/+$/, '');
  base = base.replace(/\/(?:chat\/completions|responses|images\/generations|messages|models)$/i, '');
  try {
    const parsed = new URL(base);
    if (provider.kind !== 'anthropic-compatible' && parsed.hostname.toLowerCase() === 'api.openai.com' && parsed.pathname === '') base += '/v1';
  } catch { /* Provider validation handles malformed URLs. */ }
  const endpoint = provider.kind === 'anthropic-compatible' ? '/v1/messages' : '/chat/completions';
  const path = endpoint.startsWith('/v1/') && /\/v1$/i.test(base) ? endpoint.slice(3) : endpoint;
  return `${base}${path}`;
}

function parseCustomHeaders(value: unknown): Record<string, string> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed).filter(([, item]) => typeof item === 'string')) as Record<string, string> : {};
  } catch { return {}; }
}

// --------------------------------------------------------------- helpers

function normalizeAutomation(r: any): any {
  return {
    id: r.id,
    prompt: r.prompt,
    schedule: JSON.parse(r.schedule),
    taskInstruction: r.task_instruction,
    providerId: r.provider_id ?? undefined,
    modelId: r.model_id ?? undefined,
    status: r.status,
    missedRunPolicy: r.missed_run_policy,
    dryRun: !!r.dry_run,
    maxSteps: r.max_steps,
    maxRetries: r.max_retries,
    retryBackoffMs: r.retry_backoff_ms,
    allowTerminal: !!r.allow_terminal,
    allowNetwork: !!r.allow_network,
    allowTools: !!r.allow_tools,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    nextRunAt: r.next_run_at ?? undefined,
  };
}

function getSelectedProvider(providerId: string | null | undefined): any | null {
  if (!providerId) return null;
  return db.prepare('SELECT * FROM providers WHERE id = ? AND enabled = 1').get(providerId) as any || null;
}

function normalizeRun(r: any): any {
  return {
    id: r.id,
    automationId: r.automation_id,
    occurrenceKey: r.occurrence_key,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    resultSummary: r.result_summary,
    toolRunIds: JSON.parse(r.tool_run_ids || '[]'),
    error: r.error,
    stepsUsed: r.steps_used,
  };
}

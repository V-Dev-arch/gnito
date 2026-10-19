import React, { useEffect, useState } from 'react';
import { Zap, Play, Pause, Trash2, AlertTriangle, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';

interface Automation {
  id: string; prompt: string; schedule: { expression: string; timezone: string; kind: string };
  taskInstruction: string; status: string; missedRunPolicy: string; dryRun: boolean;
  maxSteps: number; nextRunAt?: number;
}
interface Run { id: string; status: string; startedAt?: number; endedAt?: number; resultSummary?: string; error?: string }

const MISSED_RUN_WARNING =
  'Your computer must stay on and the Gnito app must remain running to complete scheduled tasks. ' +
  'If your computer is turned off, asleep, or the app is closed, tasks may be delayed or missed. ' +
  'Tasks can resume when the app starts again, according to your missed-task settings.';

export function AutomationsPage() {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [selected, setSelected] = useState<Automation | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [creating, setCreating] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [taskInstruction, setTaskInstruction] = useState('');
  const [expression, setExpression] = useState('');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [kind, setKind] = useState<'recurring' | 'one-shot'>('recurring');
  const [missedPolicy, setMissedPolicy] = useState<'skip' | 'run-once-on-startup' | 'catch-up-within-window'>('skip');
  const [dryRun, setDryRun] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { push } = useToast();

  const load = () => api.get('/api/automations').then(setAutomations).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);

  const openDetail = async (a: Automation) => {
    setSelected(a);
    const r = await api.get(`/api/automations/${a.id}`);
    setRuns(r.runs);
  };

  const create = async () => {
    if (!prompt.trim() || !expression.trim()) { push('Fill in prompt and schedule.', 'error'); return; }
    try {
      const r = await api.post('/api/automations', {
        prompt, taskInstruction, schedule: { expression, timezone, kind },
        missedRunPolicy: missedPolicy, dryRun, maxSteps: 10, maxRetries: 1, retryBackoffMs: 30_000,
      });
      await api.post(`/api/automations/${r.id}/activate`);
      push('Automation created and activated.', 'success');
      setCreating(false); setPrompt(''); setExpression('');
      load();
    } catch (e: any) { push(e.message, 'error'); }
  };

  return (
    <div className="page-frame">
      <header className="page-heading page-heading-split">
        <div>
          <h1 className="page-title"><Zap size={20} style={{ display: 'inline', marginRight: 8, verticalAlign: 'text-bottom' }} />Automation Center</h1>
          <p className="page-lede">Schedule natural-language tasks. Runs on your machine, while Gnito is running.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)} data-testid="button-new-automation">
          New automation
        </button>
      </header>

      <div className="automation-warning" role="status" data-testid="automation-warning">
        <AlertTriangle size={16} />
        <span>{MISSED_RUN_WARNING}</span>
      </div>

      {error && <div className="card" style={{ borderColor: 'var(--color-error)', marginBottom: 16 }}>{error}</div>}

      {creating && (
        <div className="card" style={{ marginBottom: 16 }} data-testid="create-automation-form">
          <div className="card-title">Describe your task</div>
          <div className="field">
            <label className="label" htmlFor="au-prompt">Natural-language prompt</label>
            <input id="au-prompt" className="input" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Every Saturday at 8 AM, give me morning news." data-testid="input-automation-prompt" />
          </div>
          <div className="field-row">
            <div className="field">
              <label className="label" htmlFor="au-instr">Task instruction (what the model does)</label>
              <textarea id="au-instr" className="textarea" value={taskInstruction} onChange={e => setTaskInstruction(e.target.value)} placeholder="Summarize today's top headlines in 5 bullets." />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label className="label" htmlFor="au-kind">Schedule type</label>
              <select id="au-kind" className="select" value={kind} onChange={e => setKind(e.target.value as any)} data-testid="select-automation-kind">
                <option value="recurring">Recurring (cron)</option>
                <option value="one-shot">One-shot (ISO timestamp)</option>
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="au-expr">{kind === 'recurring' ? 'Cron expression (5 fields)' : 'ISO timestamp'}</label>
              <input id="au-expr" className="input" value={expression} onChange={e => setExpression(e.target.value)} placeholder={kind === 'recurring' ? '0 8 * * 6' : '2026-12-25T09:00:00'} data-testid="input-automation-expression" />
            </div>
            <div className="field">
              <label className="label" htmlFor="au-tz">Timezone</label>
              <input id="au-tz" className="input" value={timezone} onChange={e => setTimezone(e.target.value)} />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label className="label" htmlFor="au-missed">Missed-run policy</label>
              <select id="au-missed" className="select" value={missedPolicy} onChange={e => setMissedPolicy(e.target.value as any)}>
                <option value="skip">Skip missed</option>
                <option value="run-once-on-startup">Run once on startup</option>
                <option value="catch-up-within-window">Catch up within window</option>
              </select>
            </div>
            <div className="field">
              <label className="label">Dry-run</label>
              <div className="settings-row" style={{ border: 'none' }}>
                <div>
                  <div className="settings-row-label">Preview only</div>
                  <div className="settings-row-desc">Don't perform tool side-effects.</div>
                </div>
                <button className={`toggle ${dryRun ? 'on' : ''}`} onClick={() => setDryRun(d => !d)} role="switch" aria-checked={dryRun} aria-label="Dry run" data-testid="toggle-dry-run">
                  <span className="toggle-thumb" />
                </button>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={create} data-testid="button-create-automation">Create + activate</button>
            <button className="btn btn-secondary" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </div>
      )}

      {automations.length === 0 && !creating && (
        <div className="empty-state">
          <Zap size={44} style={{ color: 'var(--color-text-faint)', margin: '0 auto 16px' }} />
          <div className="empty-state-title">No automations yet</div>
          <div className="empty-state-text">Create a scheduled task to run on your machine.</div>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>Create your first automation</button>
        </div>
      )}

      {automations.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          {automations.map(a => (
            <div key={a.id} className="automation-row" data-testid={`automation-${a.id}`}>
              <div style={{ flex: 1 }}>
                <div className="automation-title">{a.prompt.slice(0, 80)}{a.prompt.length > 80 ? '…' : ''}</div>
                <div className="automation-meta">
                  {a.schedule.kind} · {a.schedule.expression} · {a.schedule.timezone}
                  {a.nextRunAt ? ` · next: ${new Date(a.nextRunAt).toLocaleString()}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className={`automation-status-badge ${a.status}`}>{a.status}</span>
                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => openDetail(a)} aria-label="View details" data-testid={`button-view-${a.id}`}>
                  <RefreshCw size={14} />
                </button>
                {a.status === 'active' ? (
                  <button className="btn btn-ghost btn-icon btn-sm" onClick={async () => { await api.post(`/api/automations/${a.id}/pause`); load(); }} aria-label="Pause" data-testid={`button-pause-${a.id}`}>
                    <Pause size={14} />
                  </button>
                ) : (
                  <button className="btn btn-ghost btn-icon btn-sm" onClick={async () => { await api.post(`/api/automations/${a.id}/activate`); load(); }} aria-label="Activate" data-testid={`button-activate-${a.id}`}>
                    <Play size={14} />
                  </button>
                )}
                <button className="btn btn-ghost btn-icon btn-sm" onClick={async () => { await api.post(`/api/automations/${a.id}/run-now`); push('Run triggered', 'success'); }} aria-label="Run now" data-testid={`button-run-now-${a.id}`}>
                  <Zap size={14} />
                </button>
                <button className="btn btn-danger btn-icon btn-sm" onClick={async () => { await api.delete(`/api/automations/${a.id}`); load(); }} aria-label="Delete" data-testid={`button-delete-${a.id}`}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <div className="card" style={{ marginTop: 16 }} data-testid="automation-detail">
          <div className="card-title">Automation detail</div>
          <div className="card-description">{selected.taskInstruction}</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
            Missed-run policy: {selected.missedRunPolicy} · dry-run: {String(selected.dryRun)} · max steps: {selected.maxSteps}
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, marginBottom: 8 }}>Run history</div>
            {runs.length === 0 && <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>No runs yet.</div>}
            {runs.map(r => (
              <div key={r.id} className="tool-run-card" data-testid={`run-${r.id}`}>
                <div className="tool-run-header">
                  <span className="tool-run-name">{r.status}</span>
                  <span className={`tool-run-status ${r.status}`}>{r.startedAt ? new Date(r.startedAt).toLocaleString() : 'not started'}</span>
                </div>
                {r.resultSummary && <div className="tool-run-details">{r.resultSummary.slice(0, 500)}</div>}
                {r.error && <div className="tool-run-details" style={{ color: 'var(--color-error)' }}>{r.error}</div>}
              </div>
            ))}
          </div>
          <button className="btn btn-secondary" style={{ marginTop: 12 }} onClick={() => setSelected(null)}>Close</button>
        </div>
      )}
    </div>
  );
}

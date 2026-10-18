import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, LoaderCircle, Play, RefreshCw, Square, Terminal, Wifi } from 'lucide-react';
import { api } from '../../lib/api';

interface SandboxStatus {
  provider: 'docker';
  available: boolean;
  cliAvailable: boolean;
  daemonAvailable: boolean;
  imageAvailable: boolean;
  image: string;
  workspaceDir: string;
  workspaceLimitBytes: number;
  reason?: string;
}

interface ToolRun {
  id: string;
  tool: string;
  input: string;
  output: string | null;
  status: string;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

function runCommand(run: ToolRun): string {
  try { return String(JSON.parse(run.input)?.command || ''); }
  catch { return ''; }
}

function runUsesNetwork(run: ToolRun): boolean {
  try { return JSON.parse(run.input)?.networkAccess === true; }
  catch { return false; }
}

function runOutput(run: ToolRun): { exitCode?: number; stdout?: string; stderr?: string } | null {
  try {
    const result = typeof run.output === 'string' ? JSON.parse(run.output) : run.output;
    return result && typeof result === 'object' ? result : null;
  } catch { return null; }
}

function statusMessage(status: SandboxStatus | null): string {
  if (!status) return 'Checking Docker sandbox…';
  if (status.available) return `Ready · ${status.image}`;
  if (status.reason === 'docker-not-installed') return 'Unavailable · Docker CLI is not installed';
  if (status.reason === 'docker-daemon-unavailable') return 'Unavailable · Docker daemon is stopped or inaccessible';
  if (status.reason === 'sandbox-image-not-built') return 'Unavailable · Gnito sandbox image is not built';
  if (status.reason === 'server-running-as-root') return 'Unavailable · Gnito is running as root';
  return 'Unavailable · Docker sandbox is not ready';
}

export function TerminalPage() {
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [runs, setRuns] = useState<ToolRun[]>([]);
  const [command, setCommand] = useState('pwd && ls -la');
  const [networkAccess, setNetworkAccess] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState(300_000);
  const [running, setRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try { setStatus(await api.get('/api/tools/sandbox/status')); }
    catch (e: any) { setStatus(null); setError(`Could not check Docker sandbox status. ${e.message}`); }
  }, []);

  const refreshRuns = useCallback(async () => {
    try {
      const result = await api.get('/api/tools/runs?context=terminal-ui');
      setRuns((result as ToolRun[]).filter(run => run.tool === 'terminal_run'));
    } catch (e: any) {
      setError(`Could not load terminal history. ${e.message}`);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void refreshStatus();
    void refreshRuns();
    const timer = window.setInterval(() => {
      if (alive) { void refreshStatus(); void refreshRuns(); }
    }, 5_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [refreshStatus, refreshRuns]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => { void refreshRuns(); }, 700);
    return () => window.clearInterval(timer);
  }, [running, refreshRuns]);

  const run = async () => {
    const exactCommand = command.trim();
    if (!exactCommand || !status?.available || running) return;
    setError(null);
    setRunning(true);
    setActiveRunId(null);
    try {
      const request = await api.post('/api/tools/terminal_run/request', {
        command: exactCommand,
        timeoutMs,
        networkAccess,
        context: 'terminal-ui',
      });
      setActiveRunId(request.runId);
      await refreshRuns();
      await api.post(`/api/tools/runs/${request.runId}/approve`, {});
      const execution = api.post(`/api/tools/runs/${request.runId}/execute`, {});
      await refreshRuns();
      const result = await execution;
      if (result.status === 'failed') setError(result.error || 'The isolated command failed.');
      await refreshRuns();
    } catch (e: any) {
      setError(`Terminal command could not be run. ${e.message}`);
      await refreshRuns();
    } finally {
      setRunning(false);
      setActiveRunId(null);
    }
  };

  const cancel = async () => {
    if (!activeRunId) return;
    try { await api.post(`/api/tools/runs/${activeRunId}/cancel`, {}); }
    catch (e: any) { setError(`Could not cancel the terminal command. ${e.message}`); }
  };

  const copySetupCommand = async () => {
    try {
      await navigator.clipboard.writeText('docker build --pull -t gnito-sandbox:3.24.2 -f docker/terminal/Dockerfile .');
    } catch { setError('Could not copy the Docker build command.'); }
  };

  return (
    <div className="terminal-page">
      <header className="terminal-header">
        <div>
          <h1 className="terminal-title"><Terminal size={22} style={{ verticalAlign: 'text-bottom', marginRight: 9 }} />Terminal</h1>
          <p className="terminal-description">Commands run only inside a restricted Docker container. They can read and change files in this Gnito sandbox workspace.</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => { void refreshStatus(); void refreshRuns(); }} data-testid="button-refresh-terminal"><RefreshCw size={14} /> Refresh</button>
      </header>

      <section className={`terminal-status ${status?.available ? 'ready' : status ? 'unavailable' : ''}`} role="status" data-testid="sandbox-status">
        {status?.available ? <CheckCircle2 size={18} color="var(--color-success)" /> : status ? <CircleAlert size={18} color="var(--color-warning)" /> : <LoaderCircle size={18} className="spin" />}
        <div className="terminal-status-copy">
          <strong>{statusMessage(status)}</strong>
          {status?.workspaceDir && <span>Persistent workspace: <span className="terminal-workspace-path">{status.workspaceDir}</span></span>}
          {status?.reason === 'sandbox-image-not-built' && <div className="terminal-setup"><span>Build the image from the Gnito repository root:</span><code>docker build --pull -t gnito-sandbox:3.24.2 -f docker/terminal/Dockerfile .</code><button className="btn btn-ghost btn-sm" onClick={copySetupCommand}>Copy</button></div>}
          {status?.reason === 'docker-not-installed' && <span>Install Docker Engine or Docker Desktop, start its daemon, then build the Gnito sandbox image.</span>}
          {status?.reason === 'docker-daemon-unavailable' && <span>Start Docker Engine and refresh. Commands are disabled until the daemon is available.</span>}
          {status?.reason === 'server-running-as-root' && <span>Restart Gnito under a non-root OS user. Terminal is intentionally disabled for a root server process.</span>}
        </div>
      </section>

      <section className="card terminal-command-card" aria-label="Run a terminal command">
        <div>
          <label className="label" htmlFor="terminal-command">Command</label>
          <textarea id="terminal-command" className="textarea terminal-command" value={command} onChange={event => setCommand(event.target.value)} placeholder="Enter a shell command" disabled={!status?.available || running} data-testid="input-terminal-command" />
          <div className="terminal-options">
            <label className="terminal-network-toggle">
              <input type="checkbox" checked={networkAccess} onChange={event => setNetworkAccess(event.target.checked)} disabled={!status?.available || running} />
              <span><strong><Wifi size={14} /> Allow outbound network for this run</strong><small>Off by default. When enabled, commands can reach the public internet and network destinations reachable from Docker.</small></span>
            </label>
            <label className="terminal-timeout-select">Timeout
              <select className="select" value={timeoutMs} onChange={event => setTimeoutMs(Number(event.target.value))} disabled={running}>
                <option value={60_000}>1 minute</option><option value={180_000}>3 minutes</option><option value={300_000}>5 minutes</option>
              </select>
            </label>
          </div>
          <p className="terminal-command-meta">Review the exact command before running it. Only the Gnito sandbox workspace is mounted; no host credentials are injected. A persistent sandbox home stores CLI configuration inside that workspace, so treat saved credentials as local secrets. Interactive stdin is not supported; for GitHub use <code>gh auth login --web --hostname github.com --git-protocol https</code> and follow the device-code prompt shown in live output. Docker memory is limited to 512 MB; workspace usage is capped at 256 MiB and Gnito preserves 128 MiB of host disk headroom.</p>
        </div>
        <div className="terminal-actions">
          <button className="btn btn-primary" onClick={() => void run()} disabled={!status?.available || !command.trim() || running} data-testid="button-run-terminal">
            {running ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}{running ? 'Running…' : 'Run command'}
          </button>
          {running && <button className="btn btn-danger" onClick={() => void cancel()} disabled={!activeRunId} data-testid="button-cancel-terminal"><Square size={14} /> Stop</button>}
          {running && <span className="terminal-command-meta">The exact command is visible in terminal history below.</span>}
        </div>
      </section>

      {error && <div className="request-error" role="alert" data-testid="terminal-error"><div><strong>Terminal status</strong><p>{error}</p></div><button className="btn btn-ghost btn-sm" onClick={() => setError(null)}>Dismiss</button></div>}

      <section aria-label="Terminal run history">
        <h2 className="settings-section-title">Recent runs</h2>
        {!runs.length ? <div className="card card-description">Commands and their output will appear here after you run them.</div> : <div className="terminal-runs" data-testid="terminal-runs">
          {runs.slice(0, 30).map(run => {
            const output = runOutput(run);
            const parts = [output?.stdout, output?.stderr].filter(Boolean).join('\n');
            return <article className="terminal-run" key={run.id} data-testid={`terminal-run-${run.id}`}>
              <div className="terminal-run-header">
                <code className="terminal-run-command">{runCommand(run) || '(command unavailable)'}</code>
                <span className={`terminal-run-status ${run.status}`}>{runUsesNetwork(run) ? 'network · ' : ''}{run.status}{output?.exitCode !== undefined ? ` · exit ${output.exitCode}` : ''}</span>
              </div>
              {(parts || run.error) && <div className="terminal-run-output"><pre>{[parts, run.error ? `Error: ${run.error}` : ''].filter(Boolean).join('\n')}</pre></div>}
            </article>;
          })}
        </div>}
      </section>
    </div>
  );
}

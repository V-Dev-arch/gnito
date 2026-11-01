import React, { useEffect, useState } from 'react';
import { Plug, Trash2, Upload } from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';

interface Plugin {
  id: string;
  builtIn?: boolean;
  manifest: { name: string; version: string; description: string; author: string; license: string; permissions: string[]; tools?: string[] };
  enabled: boolean; state: string; connected?: boolean;
}

export function PluginsPage() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [sourcePath, setSourcePath] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [githubStatus, setGithubStatus] = useState<any>(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { push } = useToast();

  const load = async () => {
    try {
      setPlugins(await api.get('/api/plugins'));
      setGithubStatus(await api.get('/api/plugins/github/status'));
    } catch (e: any) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const install = async () => {
    if (!sourcePath.trim()) return;
    try {
      await api.post('/api/plugins/install', { sourcePath });
      push('Plugin installed.', 'success');
      setSourcePath('');
      load();
    } catch (e: any) { push(e.message, 'error'); }
  };

  const connectGithub = async () => {
    if (!githubToken.trim()) return;
    setGithubBusy(true);
    try {
      await api.post('/api/plugins/github/connect', { token: githubToken });
      setGithubToken('');
      push('GitHub connected. The PAT remains encrypted locally.', 'success');
      await load();
    } catch (e: any) { push(e.message, 'error'); }
    finally { setGithubBusy(false); }
  };

  const disconnectGithub = async () => {
    setGithubBusy(true);
    try {
      await api.delete('/api/plugins/github');
      push('GitHub disconnected and the encrypted PAT was removed.', 'success');
      await load();
    } catch (e: any) { push(e.message, 'error'); }
    finally { setGithubBusy(false); }
  };

  return (
    <div className="page-frame">
      <header className="page-heading">
        <div>
        <h1 className="page-title"><Plug size={20} style={{ display: 'inline', marginRight: 8, verticalAlign: 'text-bottom' }} />Plugins & Integrations</h1>
        <p className="page-lede">
          Install plugins from a local directory. Plugin code runs in the Gnito process — review manifests before installing.
        </p>
        </div>
      </header>

      {error && <div className="card" style={{ borderColor: 'var(--color-error)', marginBottom: 16 }}>{error}</div>}

      <div className="plugin-card" style={{ marginBottom: 16 }} data-testid="plugin-github">
        <img src="/brand/providers/github.svg" alt="GitHub logo" width="34" height="34" style={{ color: 'var(--color-text)' }} />
        <div style={{ flex: 1 }}>
          <div className="plugin-name">GitHub <span style={{ color: 'var(--color-text-faint)' }}>built-in</span></div>
          <div className="plugin-desc">Give the AI GitHub REST API access. GitHub enforces the scopes and fine-grained repository permissions selected when the PAT was created.</div>
          <div className="plugin-permissions"><span className="permission-badge">github:read</span><span className="permission-badge">github:write</span><span className="permission-badge">encrypted PAT</span></div>
          {githubStatus?.connected && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 6 }}>Connected as <strong>{githubStatus.login || 'GitHub user'}</strong>{githubStatus.scopes?.length ? ` · token scopes: ${githubStatus.scopes.join(', ')}` : ' · fine-grained permissions are enforced per request'}</div>}
          <div className="field-row" style={{ marginTop: 10 }}>
            <div className="field"><input className="input" type="password" value={githubToken} onChange={e => setGithubToken(e.target.value)} placeholder="ghp_… or github_pat_…" aria-label="GitHub personal access token" data-testid="input-github-token" /></div>
            <button className="btn btn-primary" onClick={() => void connectGithub()} disabled={githubBusy || !githubToken.trim()} data-testid="button-connect-github">{githubBusy ? 'Connecting…' : 'Connect GitHub'}</button>
          </div>
          <div className="card-description" style={{ marginTop: 6 }}>Create a classic or fine-grained PAT on GitHub with only the repository, issue, pull request, or workflow access you want Gnito to use. The token is never sent to the model.</div>
        </div>
        {githubStatus?.connected && <button className="btn btn-danger btn-sm" onClick={() => void disconnectGithub()} disabled={githubBusy} data-testid="button-disconnect-github">Disconnect</button>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">Install from local path</div>
        <div className="card-description">Point to a folder containing <code>manifest.json</code>. See docs/plugin-sdk.md.</div>
        <div className="field-row">
          <div className="field">
            <input className="input" value={sourcePath} onChange={e => setSourcePath(e.target.value)} placeholder="/home/you/my-plugin" aria-label="Plugin source path" data-testid="input-plugin-path" />
          </div>
          <button className="btn btn-primary" onClick={install} data-testid="button-install-plugin">
            <Upload size={14} /> Install
          </button>
        </div>
      </div>

      {plugins.length === 0 && (
        <div className="empty-state">
          <Plug size={44} style={{ color: 'var(--color-text-faint)', margin: '0 auto 16px' }} />
          <div className="empty-state-title">No plugins installed</div>
          <div className="empty-state-text">Install from a local path, or check out the example plugin in <code>plugins/example/</code>.</div>
        </div>
      )}

      {plugins.filter(p => !p.builtIn).map(p => (
        <div key={p.id} className="plugin-card" style={{ marginBottom: 12 }} data-testid={`plugin-${p.id}`}>
          <div style={{ flex: 1 }}>
            <div className="plugin-name">{p.manifest.name} <span style={{ color: 'var(--color-text-faint)' }}>v{p.manifest.version}</span></div>
            <div className="plugin-desc">{p.manifest.description}</div>
            <div className="plugin-permissions">
              {p.manifest.permissions.map(perm => <span key={perm} className="permission-badge">{perm}</span>)}
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-faint)', marginTop: 4 }}>
              by {p.manifest.author} · {p.manifest.license}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => { await api.patch(`/api/plugins/${p.id}`, { enabled: !p.enabled }); load(); }}
              data-testid={`button-toggle-${p.id}`}
            >
              {p.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              className="btn btn-danger btn-sm"
              onClick={async () => { await api.delete(`/api/plugins/${p.id}`); load(); }}
              data-testid={`button-uninstall-${p.id}`}
            >
              <Trash2 size={12} /> Uninstall
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

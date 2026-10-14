import React, { useEffect, useState } from 'react';
import { Plug, Trash2, Upload } from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';

interface Plugin {
  id: string;
  manifest: { name: string; version: string; description: string; author: string; license: string; permissions: string[] };
  enabled: boolean; state: string;
}

export function PluginsPage() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [sourcePath, setSourcePath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { push } = useToast();

  const load = () => api.get('/api/plugins').then(setPlugins).catch(e => setError(e.message));
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

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto', width: '100%' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 700 }}><Plug size={20} style={{ display: 'inline', marginRight: 8, verticalAlign: 'text-bottom' }} />Plugins & Integrations</h1>
        <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
          Install plugins from a local directory. Plugin code runs in the Gnito process — review manifests before installing.
        </p>
      </div>

      {error && <div className="card" style={{ borderColor: 'var(--color-error)', marginBottom: 16 }}>{error}</div>}

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

      {plugins.map(p => (
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

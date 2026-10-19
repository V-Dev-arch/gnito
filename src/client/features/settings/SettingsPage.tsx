import React, { useEffect, useState } from 'react';
import { Settings, KeyRound, Database, Shield, Download, Upload, Trash2, Zap, Mic, Lock, Search } from 'lucide-react';
import { CUSTOM_PROVIDER_PRESET, MANUS_PROVIDER_NOTICE, PROVIDER_PRESETS, type ProviderPreset } from '../../../shared/providerPresets';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { ProviderLogo } from '../../ui/ProviderLogo';

interface Provider {
  id: string; kind: string; label: string; baseUrl: string; enabled: boolean; hasKey: boolean;
}

function providerPresetFor(provider: Provider): ProviderPreset {
  return PROVIDER_PRESETS.find(p => provider.baseUrl.replace(/\/$/, '').startsWith(p.baseUrl.replace(/\/$/, '')))
    || { ...CUSTOM_PROVIDER_PRESET, label: provider.label, baseUrl: provider.baseUrl };
}

const SECTIONS = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'providers', label: 'Models & Providers', icon: KeyRound },
  { id: 'storage', label: 'Local Storage', icon: Database },
  { id: 'memory', label: 'Memory & Privacy', icon: Shield },
  { id: 'automations', label: 'Automations', icon: Zap },
  { id: 'tools', label: 'Tools & Search', icon: Search },
  { id: 'audio', label: 'Audio & Mic', icon: Mic },
  { id: 'backup', label: 'Backup & Restore', icon: Download },
  { id: 'diagnostics', label: 'Diagnostics', icon: Lock },
];

export function SettingsPage() {
  const [section, setSection] = useState('general');
  const [providers, setProviders] = useState<Provider[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [searchBackendDraft, setSearchBackendDraft] = useState('');
  const [diagnostics, setDiagnostics] = useState<any>(null);
  const [presetId, setPresetId] = useState('openai');
  const [newProvider, setNewProvider] = useState({ label: PROVIDER_PRESETS[0].label, baseUrl: PROVIDER_PRESETS[0].baseUrl, apiKey: '', kind: PROVIDER_PRESETS[0].kind as string });
  const [backupPassword, setBackupPassword] = useState('');
  const [backups, setBackups] = useState<any[]>([]);
  const [restoreInfo, setRestoreInfo] = useState({ path: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const { push } = useToast();

  const load = async () => {
    try {
      setProviders(await api.get('/api/providers'));
      const loadedSettings = await api.get('/api/settings');
      setSettings(loadedSettings);
      setSearchBackendDraft(loadedSettings['workspace.searchBackend'] || '');
      setDiagnostics(await api.get('/api/diagnostics'));
      setBackups(await api.get('/api/backup/list'));
    } catch (e: any) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const addProvider = async () => {
    if (!newProvider.label || !newProvider.baseUrl) { push('Label and base URL are required.', 'error'); return; }
    if (newProvider.kind !== 'custom' && !newProvider.apiKey.trim()) { push('Add an API key for this provider.', 'error'); return; }
    try {
      const { apiKey, ...providerInput } = newProvider;
      await api.post('/api/providers', { ...providerInput, ...(apiKey ? { apiKey } : {}) });
      push('Provider added. Key stored encrypted locally.', 'success');
      setPresetId('openai');
      setNewProvider({ label: PROVIDER_PRESETS[0].label, baseUrl: PROVIDER_PRESETS[0].baseUrl, apiKey: '', kind: PROVIDER_PRESETS[0].kind });
      load();
    } catch (e: any) { push(e.message, 'error'); }
  };

  const testProvider = async (id: string) => {
    const r = await api.post(`/api/providers/${id}/test`);
    if (r.ok) push(`Connection OK (${r.latencyMs} ms, ${r.models?.length ?? 0} models).`, 'success');
    else push(r.error || 'Connection failed.', 'error');
  };

  const createBackup = async () => {
    if (backupPassword.length < 8) { push('Password must be at least 8 characters.', 'error'); return; }
    try {
      const r = await api.post('/api/backup/create', {
        password: backupPassword,
        options: { includeChats: true, includeProjects: true, includeSettings: true, includeSecrets: false },
      });
      push(`Backup created: ${r.filename}`, 'success');
      setBackupPassword('');
      load();
    } catch (e: any) { push(e.message, 'error'); }
  };

  const restoreBackup = async () => {
    if (!restoreInfo.path || restoreInfo.password.length < 8) { push('Provide file path and password.', 'error'); return; }
    try {
      const r = await api.post('/api/backup/restore', { ...restoreInfo, overwrite: false });
      push(`Restore OK: ${JSON.stringify(r.applied)}`, 'success');
    } catch (e: any) { push(e.message, 'error'); }
  };

  const setSetting = (key: string, value: string) => {
    api.put(`/api/settings/${key}`, { value }).then(() => load()).catch(e => push(e.message, 'error'));
  };

  const saveSearchBackend = async (override?: string) => {
    const value = (override ?? searchBackendDraft).trim();
    if (value) {
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
      } catch {
        push('Enter an HTTPS search endpoint without embedded credentials or a fragment.', 'error');
        return;
      }
    }
    try {
      await api.put('/api/settings/workspace.searchBackend', { value });
      push(value ? 'Search backend saved.' : 'Default Brave Search restored.', 'success');
      await load();
    } catch (e: any) { push(e.message, 'error'); }
  };

  const SectionIcon = SECTIONS.find(s => s.id === section)?.icon || Settings;

  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`sidebar-link ${section === id ? 'active' : ''}`}
            onClick={() => setSection(id)}
            data-testid={`settings-nav-${id}`}
          >
            <Icon size={16} />
            <span className="sidebar-label">{label}</span>
          </button>
        ))}
      </nav>

      <div className="settings-section">
        <h2 className="settings-section-title"><SectionIcon size={18} style={{ display: 'inline', marginRight: 8, verticalAlign: 'text-bottom' }} />
          {SECTIONS.find(s => s.id === section)?.label}
        </h2>

        {error && <div className="card" style={{ borderColor: 'var(--color-error)', marginBottom: 16 }}>{error}</div>}

        {section === 'general' && (
          <div className="card">
            <div className="settings-row">
              <div>
                <div className="settings-row-label">Enter to send</div>
                <div className="settings-row-desc">Press Enter to send, Shift+Enter for newline.</div>
              </div>
              <button
                className={`toggle ${settings['chat.enterToSend'] !== 'false' ? 'on' : ''}`}
                onClick={() => setSetting('chat.enterToSend', settings['chat.enterToSend'] === 'false' ? 'true' : 'false')}
                role="switch"
                aria-checked={settings['chat.enterToSend'] !== 'false'}
                aria-label="Enter to send"
                data-testid="toggle-enter-to-send"
              >
                <span className="toggle-thumb" />
              </button>
            </div>
          </div>
        )}

        {section === 'providers' && (
          <>
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-title">Add a provider</div>
              <div className="card-description">
                Bring your own key. Costs, quotas, and data policies depend on the provider.
                Keys are stored encrypted in your local Gnito data dir and sent only to the selected provider. Manus runs remotely on Manus infrastructure; it does not use Gnito’s local sandbox or MCP connectors.
              </div>
              <div className="field-row">
                <div className="field">
                  <label className="label" htmlFor="sp-preset">Provider</label>
                  <select id="sp-preset" className="select" value={presetId} onChange={e => {
                    const value = e.target.value;
                    setPresetId(value);
                    const preset = PROVIDER_PRESETS.find(p => p.id === value);
                    if (preset) setNewProvider(current => ({ ...current, label: preset.label, baseUrl: preset.baseUrl, kind: preset.kind }));
                    else setNewProvider(current => ({ ...current, label: '', baseUrl: '', kind: 'custom' }));
                  }} data-testid="select-provider-kind">
                    {PROVIDER_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                    <option value="custom">Custom OpenAI-compatible</option>
                  </select>
                </div>
                <div className="field">
                  <label className="label" htmlFor="sp-label">Label</label>
                  <input id="sp-label" className="input" value={newProvider.label} onChange={e => setNewProvider({ ...newProvider, label: e.target.value })} placeholder="OpenAI" data-testid="input-provider-label" />
                </div>
              </div>
              <div className="field">
                <label className="label" htmlFor="sp-url">Base URL</label>
                <input id="sp-url" className="input" value={newProvider.baseUrl} onChange={e => setNewProvider({ ...newProvider, baseUrl: e.target.value })} placeholder="https://your-provider.example/v1" readOnly={presetId !== 'custom'} data-testid="input-provider-url" />
              </div>
              <div className="provider-note">{presetId === 'custom' ? 'Use the API root for an OpenAI-compatible endpoint. Model discovery uses its /models route.' : presetId === 'manus' ? `${MANUS_PROVIDER_NOTICE} Choose a Manus agent profile below rather than a model ID.` : 'Preset includes the official provider API root. Add your own API key to connect.'}</div>
              <div className="field">
                <label className="label" htmlFor="sp-key">API key (stored encrypted, never shown again)</label>
                <input id="sp-key" type="password" className="input" value={newProvider.apiKey} onChange={e => setNewProvider({ ...newProvider, apiKey: e.target.value })} placeholder="sk-…" data-testid="input-provider-key" />
              </div>
              <button className="btn btn-primary" onClick={addProvider} data-testid="button-add-provider">Add provider</button>
            </div>

            {providers.map(p => (
              <div key={p.id} className="card" style={{ marginBottom: 12 }} data-testid={`provider-${p.id}`}>
                <div className="provider-card-title"><ProviderLogo preset={providerPresetFor(p)} size={22} /><div className="card-title">{p.label} <span style={{ color: 'var(--color-text-faint)', fontSize: 'var(--text-xs)', fontWeight: 400 }}>{p.kind}</span></div></div>
                <div className="card-description">{p.baseUrl}</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => testProvider(p.id)} data-testid={`button-test-${p.id}`}>Test connection</button>
                  <button className="btn btn-ghost btn-sm" onClick={async () => { await api.patch(`/api/providers/${p.id}`, { enabled: !p.enabled }); load(); }} data-testid={`button-toggle-${p.id}`}>
                    {p.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={async () => { await api.delete(`/api/providers/${p.id}`); load(); }} data-testid={`button-delete-${p.id}`}>
                    <Trash2 size={12} /> Delete
                  </button>
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 8 }}>
                  API key: {p.hasKey ? 'saved (encrypted)' : 'not set'}
                </div>
              </div>
            ))}
          </>
        )}

        {section === 'storage' && (
          <div className="card">
            <div className="card-title">Local data directory</div>
            <div className="card-description" style={{ fontFamily: 'var(--font-mono)' }}>{diagnostics?.dataDir}</div>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">Chat count</div>
                <div className="settings-row-desc">{diagnostics?.chatCount ?? '—'}</div>
              </div>
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">Providers</div>
                <div className="settings-row-desc">{diagnostics?.providerCount ?? '—'}</div>
              </div>
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">Uptime</div>
                <div className="settings-row-desc">{diagnostics ? `${diagnostics.uptimeSec} s` : '—'}</div>
              </div>
            </div>
          </div>
        )}

        {section === 'memory' && (
          <div className="card">
            <div className="card-title">Memory</div>
            <div className="card-description">
              Memory stores facts Gnito learns from your chats, locally. Incognito chats never write memory.
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">Enable memory</div>
                <div className="settings-row-desc">Off by default. You control every entry.</div>
              </div>
              <button
                className={`toggle ${settings['memory.enabled'] === 'true' ? 'on' : ''}`}
                onClick={() => setSetting('memory.enabled', settings['memory.enabled'] === 'true' ? 'false' : 'true')}
                role="switch"
                aria-checked={settings['memory.enabled'] === 'true'}
                aria-label="Enable memory"
                data-testid="toggle-memory"
              >
                <span className="toggle-thumb" />
              </button>
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">Delete all memory</div>
                <div className="settings-row-desc">Permanently remove all memory entries.</div>
              </div>
              <button className="btn btn-danger btn-sm" onClick={async () => { await api.delete('/api/memory'); push('Memory cleared.', 'success'); }} data-testid="button-clear-memory">
                Delete all
              </button>
            </div>
          </div>
        )}

        {section === 'automations' && (
          <div className="card">
            <div className="card-title">Automation defaults</div>
            <div className="card-description">
              The scheduler runs in the local backend. If your computer or Gnito is off, tasks may be missed — see your missed-run policy per automation.
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">Default missed-run policy</div>
                <div className="settings-row-desc">What to do when the app was off.</div>
              </div>
              <select className="select" style={{ maxWidth: 220 }} value={settings['automation.defaultMissedPolicy'] || 'skip'} onChange={e => setSetting('automation.defaultMissedPolicy', e.target.value)} data-testid="select-missed-policy">
                <option value="skip">Skip</option>
                <option value="run-once-on-startup">Run once on startup</option>
                <option value="catch-up-within-window">Catch up</option>
              </select>
            </div>
          </div>
        )}

        {section === 'tools' && (
          <div className="card">
            <div className="card-title">Web search backend</div>
            <div className="card-description">
              Leave this blank to use Brave Search; if it is rate-limited or challenged, Gnito tries DuckDuckGo once. This fallback sends the query to DuckDuckGo. You can set a public HTTPS SearXNG endpoint; private, local, link-local and special-use IP ranges are blocked, including DNS results, and redirects are not followed. Gnito accepts HTML or SearXNG JSON; snippets are treated as untrusted content.
            </div>
            <div className="field">
              <label className="label" htmlFor="search-backend">Search endpoint URL</label>
              <input id="search-backend" className="input" value={searchBackendDraft} onChange={event => setSearchBackendDraft(event.target.value)} placeholder="Default Brave Search" data-testid="input-search-backend" />
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={() => void saveSearchBackend()} data-testid="button-save-search-backend">Save endpoint</button>
              <button className="btn btn-secondary" onClick={() => { setSearchBackendDraft(''); void saveSearchBackend(''); }} data-testid="button-default-search-backend">Use default search providers</button>
            </div>
          </div>
        )}

        {section === 'audio' && (
          <div className="card">
            <div className="card-title">Audio & microphone</div>
            <div className="card-description">
              Audio features depend on your provider's capabilities. Gnito never claims local processing when it isn't.
              Browser speech recognition uses the browser's engine and may send audio to the browser vendor.
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">Microphone input</div>
                <div className="settings-row-desc">Enable voice dictation (browser-based).</div>
              </div>
              <button
                className={`toggle ${settings['audio.micEnabled'] === 'true' ? 'on' : ''}`}
                onClick={() => setSetting('audio.micEnabled', settings['audio.micEnabled'] === 'true' ? 'false' : 'true')}
                role="switch"
                aria-checked={settings['audio.micEnabled'] === 'true'}
                aria-label="Microphone input"
                data-testid="toggle-mic"
              >
                <span className="toggle-thumb" />
              </button>
            </div>
          </div>
        )}

        {section === 'backup' && (
          <>
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-title">Create encrypted backup</div>
              <div className="card-description">
                Backups are encrypted with a password you choose (AES-256-GCM, scrypt key derivation).
                API keys are excluded by default. If you forget the password, the backup cannot be recovered.
              </div>
              <div className="field">
                <label className="label" htmlFor="bk-pass">Backup password (min 8 chars)</label>
                <input id="bk-pass" type="password" className="input" value={backupPassword} onChange={e => setBackupPassword(e.target.value)} data-testid="input-backup-password" />
              </div>
              <button className="btn btn-primary" onClick={createBackup} data-testid="button-create-backup">
                <Download size={14} /> Create backup
              </button>
            </div>

            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-title">Restore from backup</div>
              <div className="card-description">Restores create new records; nothing is overwritten unless you opt in.</div>
              <div className="field">
                <label className="label" htmlFor="rs-path">Backup file path</label>
                <input id="rs-path" className="input" value={restoreInfo.path} onChange={e => setRestoreInfo({ ...restoreInfo, path: e.target.value })} placeholder="/home/you/.gnito/backups/…" data-testid="input-restore-path" />
              </div>
              <div className="field">
                <label className="label" htmlFor="rs-pass">Password</label>
                <input id="rs-pass" type="password" className="input" value={restoreInfo.password} onChange={e => setRestoreInfo({ ...restoreInfo, password: e.target.value })} data-testid="input-restore-password" />
              </div>
              <button className="btn btn-secondary" onClick={restoreBackup} data-testid="button-restore-backup">
                <Upload size={14} /> Restore
              </button>
            </div>

            <div className="card">
              <div className="card-title">Existing backups</div>
              {backups.length === 0 && <div className="card-description">No backups yet.</div>}
              {backups.map((b: any) => (
                <div key={b.filename} className="settings-row">
                  <div>
                    <div className="settings-row-label" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{b.filename}</div>
                    <div className="settings-row-desc">{(b.sizeBytes / 1024).toFixed(1)} KB · {new Date(b.createdAt).toLocaleString()}</div>
                  </div>
                  <button className="btn btn-danger btn-sm" onClick={async () => { await api.delete(`/api/backup/${b.filename}`); load(); }} data-testid={`button-delete-backup-${b.filename}`}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {section === 'diagnostics' && (
          <div className="card">
            <div className="card-title">Diagnostics</div>
            <div className="card-description">Secrets are redacted. Incognito sessions are not included.</div>
            <pre className="message-code-block">{JSON.stringify(diagnostics, null, 2)}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

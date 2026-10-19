import React, { useEffect, useState } from 'react';
import { FileText, FolderPlus, Trash2, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';

interface Grant { id: string; rootPath: string; label: string; permissions: string[] }
interface Entry { name: string; isDir: boolean; size: number }

export function FilesPage() {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [currentPath, setCurrentPath] = useState('.');
  const [selectedGrant, setSelectedGrant] = useState<Grant | null>(null);
  const [fileContent, setFileContent] = useState<{ path: string; content: string } | null>(null);
  const [newGrantPath, setNewGrantPath] = useState('');
  const [newGrantLabel, setNewGrantLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { push } = useToast();

  const loadGrants = () => api.get('/api/files/grants').then(setGrants).catch(e => setError(e.message));
  useEffect(() => { loadGrants(); }, []);

  const listDir = async (path: string) => {
    try {
      const r = await api.get(`/api/files/list?path=${encodeURIComponent(path)}`);
      setEntries(r.entries);
      setCurrentPath(path);
      setFileContent(null);
    } catch (e: any) { setError(e.message); }
  };

  const openGrant = async (g: Grant) => {
    setSelectedGrant(g);
    await listDir('.');
  };

  const readFile = async (path: string) => {
    try {
      const r = await api.get(`/api/files/read?path=${encodeURIComponent(path)}`);
      setFileContent({ path: r.path, content: r.content });
    } catch (e: any) { setError(e.message); }
  };

  const addGrant = async () => {
    if (!newGrantPath.trim() || !newGrantLabel.trim()) return;
    try {
      await api.post('/api/files/grants', {
        rootPath: newGrantPath,
        label: newGrantLabel,
        permissions: ['files:read'],
      });
      push('Folder approved.', 'success');
      setNewGrantPath(''); setNewGrantLabel('');
      loadGrants();
    } catch (e: any) { push(e.message, 'error'); }
  };

  return (
    <div className="page-frame">
      <header className="page-heading">
        <div>
        <h1 className="page-title"><FileText size={20} style={{ display: 'inline', marginRight: 8, verticalAlign: 'text-bottom' }} />Files</h1>
        <p className="page-lede">
          Browse folders you've explicitly approved. Gnito cannot see anything outside these roots.
        </p>
        </div>
      </header>

      {error && <div className="card" style={{ borderColor: 'var(--color-error)', marginBottom: 16 }}>{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">Approve a folder</div>
        <div className="card-description">Gnito will only see files inside folders you approve. Least privilege.</div>
        <div className="field-row">
          <div className="field">
            <input className="input" value={newGrantPath} onChange={e => setNewGrantPath(e.target.value)} placeholder="/home/you/documents" aria-label="Folder path" data-testid="input-grant-path" />
          </div>
          <div className="field">
            <input className="input" value={newGrantLabel} onChange={e => setNewGrantLabel(e.target.value)} placeholder="Label (e.g. Documents)" aria-label="Folder label" data-testid="input-grant-label" />
          </div>
          <button className="btn btn-primary" onClick={addGrant} data-testid="button-add-grant">
            <FolderPlus size={14} /> Approve
          </button>
        </div>
      </div>

      <div className="files-layout">
        <div className="card">
          <div className="card-title">Approved folders</div>
          {grants.length === 0 && <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>None yet.</div>}
          {grants.map(g => (
            <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
              <button
                className={`sidebar-link ${selectedGrant?.id === g.id ? 'active' : ''}`}
                style={{ flex: 1, padding: '6px 8px' }}
                onClick={() => openGrant(g)}
                data-testid={`grant-${g.id}`}
              >
                <span className="sidebar-label">{g.label}</span>
              </button>
              <button className="btn btn-ghost btn-sm" onClick={async () => { await api.delete(`/api/files/grants/${g.id}`); loadGrants(); }} aria-label="Revoke" data-testid={`button-revoke-${g.id}`}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>

        <div>
          {selectedGrant && (
            <div className="card">
              <div className="card-title">{selectedGrant.label} <span style={{ color: 'var(--color-text-faint)', fontSize: 'var(--text-xs)' }}>{selectedGrant.rootPath}</span></div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => listDir('.')} data-testid="button-refresh-files">
                  <RefreshCw size={12} /> Refresh
                </button>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', alignSelf: 'center' }}>path: {currentPath}</span>
              </div>
              <div className="file-grid">
                {entries.map(e => (
                  <div
                    key={e.name}
                    className="file-card"
                    onClick={() => e.isDir ? listDir(`${currentPath === '.' ? '' : currentPath + '/'}${e.name}`) : readFile(`${currentPath === '.' ? '' : currentPath + '/'}${e.name}`)}
                    data-testid={`file-${e.name}`}
                  >
                    <div className="file-card-icon">
                      {e.isDir ? <FolderPlus size={22} /> : <FileText size={22} />}
                    </div>
                    <div className="file-card-name">{e.name}</div>
                    <div className="file-card-meta">{e.isDir ? 'folder' : `${e.size} bytes`}</div>
                  </div>
                ))}
              </div>
              {fileContent && (
                <div className="message-code-block" style={{ marginTop: 16 }} data-testid="file-content">
                  <div style={{ marginBottom: 8, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{fileContent.path}</div>
                  <pre>{fileContent.content.slice(0, 5000)}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

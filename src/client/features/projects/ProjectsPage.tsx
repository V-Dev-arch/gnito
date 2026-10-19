import React, { useEffect, useState } from 'react';
import { Folder, Plus, Trash2, MessageSquare } from 'lucide-react';
import { api } from '../../lib/api';
import { Link } from 'wouter';
import { useToast } from '../../lib/toast';

interface Project { id: string; name: string; instructions: string }
interface Chat { id: string; title: string; projectId: string | null }

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { push } = useToast();

  const load = async () => {
    try {
      setProjects(await api.get('/api/projects'));
      setChats(await api.get('/api/chats'));
    } catch (e: any) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!name.trim()) return;
    await api.post('/api/projects', { name, instructions });
    setName(''); setInstructions('');
    push('Project created.', 'success');
    load();
  };

  return (
    <div className="page-frame">
      <header className="page-heading">
        <div>
          <h1 className="page-title"><Folder size={20} style={{ display: 'inline', marginRight: 8, verticalAlign: 'text-bottom' }} />Projects</h1>
          <p className="page-lede">Group related chats, files, and instructions.</p>
        </div>
      </header>

      {error && <div className="card" style={{ borderColor: 'var(--color-error)', marginBottom: 16 }}>{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">New project</div>
        <div className="field">
          <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Project name" aria-label="Project name" data-testid="input-project-name" />
        </div>
        <div className="field">
          <textarea className="textarea" value={instructions} onChange={e => setInstructions(e.target.value)} placeholder="Project instructions (injected into every chat in this project)" aria-label="Project instructions" />
        </div>
        <button className="btn btn-primary" onClick={create} data-testid="button-create-project">
          <Plus size={14} /> Create project
        </button>
      </div>

      {projects.length === 0 && (
        <div className="empty-state">
          <Folder size={44} style={{ color: 'var(--color-text-faint)', margin: '0 auto 16px' }} />
          <div className="empty-state-title">No projects</div>
          <div className="empty-state-text">Create a project to organize related chats.</div>
        </div>
      )}

      {projects.map(p => (
        <div key={p.id} className="card" style={{ marginBottom: 12 }} data-testid={`project-${p.id}`}>
          <div className="card-title">{p.name}</div>
          {p.instructions && <div className="card-description">{p.instructions.slice(0, 200)}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Link href={`/projects/${p.id}`} className="btn btn-secondary btn-sm" data-testid={`button-open-${p.id}`}>
              <MessageSquare size={12} /> Open chats
            </Link>
            <button className="btn btn-danger btn-sm" onClick={async () => { await api.delete(`/api/projects/${p.id}`); load(); }} data-testid={`button-delete-${p.id}`}>
              <Trash2 size={12} /> Delete
            </button>
          </div>
          <div style={{ marginTop: 12 }}>
            {chats.filter(c => c.projectId === p.id).map(c => (
              <div key={c.id} style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', padding: '2px 0' }}>
                <Link href={`/chats/${c.id}`}>{c.title}</Link>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

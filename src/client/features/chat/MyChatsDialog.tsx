import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, FolderPlus, LoaderCircle, MessageSquare, Pencil, Plus, Search, Trash2, X, Check, Ban } from 'lucide-react';
import { Link } from 'wouter';
import { api } from '../../lib/api';

interface Chat { id: string; title: string; projectId: string | null; status: 'active' | 'archived'; updatedAt: number }
interface Project { id: string; name: string }

interface Props {
  open: boolean;
  currentChatId?: string;
  onClose: () => void;
  onDeleted: (chatId: string) => void;
}

export function MyChatsDialog({ open, currentChatId, onClose, onDeleted }: Props) {
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const [chats, setChats] = useState<Chat[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState('');
  const [editingTitle, setEditingTitle] = useState('');
  const [projectEditId, setProjectEditId] = useState('');
  const [selectedProject, setSelectedProject] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const loadChats = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setChats(await api.get(`/api/chats?status=${status}`) as Chat[]);
    } catch (e: any) {
      setError(`Could not load chats: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    if (!open) return;
    void loadChats();
  }, [open, loadChats]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setError('');
    api.get('/api/projects').then((value: Project[]) => setProjects(value)).catch((e: Error) => setError(`Could not load projects: ${e.message}`));
    window.requestAnimationFrame(() => closeRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const visibleChats = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return chats.filter(chat => !needle || chat.title.toLocaleLowerCase().includes(needle));
  }, [chats, query]);

  const saveTitle = async (chat: Chat) => {
    const title = editingTitle.trim();
    if (!title) { setError('A chat title cannot be empty.'); return; }
    setBusyId(chat.id);
    setError('');
    try {
      await api.patch(`/api/chats/${chat.id}`, { title });
      setChats(current => current.map(item => item.id === chat.id ? { ...item, title } : item));
      setEditingId('');
    } catch (e: any) { setError(`Could not rename chat: ${e.message}`); }
    finally { setBusyId(''); }
  };

  const deleteChat = async (chat: Chat) => {
    setBusyId(chat.id);
    setError('');
    try {
      await api.delete(`/api/chats/${chat.id}`);
      setChats(current => current.filter(item => item.id !== chat.id));
      setConfirmDeleteId('');
      onDeleted(chat.id);
    } catch (e: any) { setError(`Could not delete chat: ${e.message}`); }
    finally { setBusyId(''); }
  };

  const saveProject = async (chat: Chat) => {
    if (!selectedProject) { setError('Choose a project first.'); return; }
    setBusyId(chat.id);
    setError('');
    try {
      await api.patch(`/api/chats/${chat.id}`, { projectId: selectedProject });
      setChats(current => current.map(item => item.id === chat.id ? { ...item, projectId: selectedProject } : item));
      setProjectEditId('');
    } catch (e: any) { setError(`Could not add chat to project: ${e.message}`); }
    finally { setBusyId(''); }
  };

  const trapDialogFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const selector = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(selector) || [])
      .filter(element => element.getClientRects().length > 0 && element.tabIndex >= 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  if (!open) return null;

  return (
    <div className="my-chats-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="my-chats-dialog" role="dialog" aria-modal="true" aria-labelledby="my-chats-title" onKeyDown={trapDialogFocus} data-testid="dialog-my-chats">
        <header className="my-chats-header">
          <div className="my-chats-heading">
            <span className="my-chats-icon"><MessageSquare size={18} /></span>
            <div><h2 id="my-chats-title">My Chats</h2><p>Find and manage your saved conversations.</p></div>
          </div>
          <button ref={closeRef} className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close My Chats" data-testid="button-close-my-chats"><X size={18} /></button>
        </header>

        <div className="my-chats-toolbar">
          <div className="my-chats-tabs" role="tablist" aria-label="Chat status">
            <button role="tab" aria-selected={status === 'active'} className={status === 'active' ? 'active' : ''} onClick={() => setStatus('active')} data-testid="tab-active-chats"><MessageSquare size={14} /> Active</button>
            <button role="tab" aria-selected={status === 'archived'} className={status === 'archived' ? 'active' : ''} onClick={() => setStatus('archived')} data-testid="tab-archived-chats"><Archive size={14} /> Archived</button>
          </div>
          <label className="my-chats-search"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search chats…" aria-label="Search chats" data-testid="input-search-chats" /></label>
          <Link href="/" className="btn btn-primary btn-sm" onClick={onClose} data-testid="button-my-chats-new"><Plus size={14} /> New chat</Link>
        </div>

        {error && <div className="my-chats-error" role="alert" data-testid="my-chats-error">{error}</div>}
        <div className="my-chats-list" aria-live="polite" aria-busy={loading}>
          {loading ? <div className="my-chats-empty"><LoaderCircle size={18} className="spin" /> Loading chats…</div> : visibleChats.length === 0 ? <div className="my-chats-empty">{query ? 'No chats match that search.' : status === 'archived' ? 'No archived chats yet.' : 'No saved chats yet.'}</div> : visibleChats.map(chat => {
            const project = projects.find(item => item.id === chat.projectId);
            const busy = busyId === chat.id;
            return <article className={`my-chat-row ${currentChatId === chat.id ? 'current' : ''}`} key={chat.id} data-testid={`my-chat-${chat.id}`}>
              <div className="my-chat-main">
                <Link href={`/chats/${chat.id}`} className="my-chat-open" onClick={onClose} title={chat.title}>
                  <MessageSquare size={16} />
                  <span><strong>{chat.title}</strong><small>{project ? `In ${project.name}` : 'No project'} · {new Date(chat.updatedAt).toLocaleDateString()}</small></span>
                </Link>
                <div className="my-chat-actions">
                  <button className="btn btn-secondary btn-sm" onClick={() => { setEditingId(chat.id); setEditingTitle(chat.title); setError(''); }} disabled={busy} aria-label={`Rename ${chat.title}`} data-testid={`button-rename-${chat.id}`}><Pencil size={13} /> Rename</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => { setProjectEditId(projectEditId === chat.id ? '' : chat.id); setSelectedProject(chat.projectId || ''); setError(''); }} disabled={busy || projects.length === 0} aria-label={`Add ${chat.title} to a project`} title={projects.length ? 'Add this chat to a project' : 'Create a project first'} data-testid={`button-project-${chat.id}`}><FolderPlus size={13} /> Add to project</button>
                  <button className="btn btn-danger btn-sm" onClick={() => { setConfirmDeleteId(chat.id); setError(''); }} disabled={busy} aria-label={`Delete ${chat.title}`} data-testid={`button-delete-chat-${chat.id}`}><Trash2 size={13} /> Delete</button>
                </div>
              </div>

              {editingId === chat.id && <form className="my-chat-inline-form" onSubmit={event => { event.preventDefault(); void saveTitle(chat); }}>
                <input className="input" value={editingTitle} onChange={event => setEditingTitle(event.target.value)} aria-label={`New title for ${chat.title}`} maxLength={300} autoFocus data-testid={`input-rename-${chat.id}`} />
                <button className="btn btn-primary btn-sm" type="submit" disabled={busy}><Check size={13} /> Save</button>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => setEditingId('')}><Ban size={13} /> Cancel</button>
              </form>}

              {projectEditId === chat.id && <form className="my-chat-inline-form" onSubmit={event => { event.preventDefault(); void saveProject(chat); }}>
                <select className="select" value={selectedProject} onChange={event => setSelectedProject(event.target.value)} aria-label={`Choose project for ${chat.title}`} data-testid={`select-project-${chat.id}`}>
                  <option value="">Choose a project…</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !selectedProject}><FolderPlus size={13} /> Add to project</button>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => setProjectEditId('')}><Ban size={13} /> Cancel</button>
              </form>}

              {confirmDeleteId === chat.id && <div className="my-chat-confirm" role="group" aria-label={`Confirm delete ${chat.title}`}>
                <span>Delete this chat and its messages permanently?</span>
                <button className="btn btn-danger btn-sm" onClick={() => void deleteChat(chat)} disabled={busy} data-testid={`confirm-delete-${chat.id}`}>{busy ? 'Deleting…' : 'Delete chat'}</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDeleteId('')} disabled={busy}>Cancel</button>
              </div>}
            </article>;
          })}
        </div>
        <footer className="my-chats-footer"><span>{visibleChats.length} {visibleChats.length === 1 ? 'chat' : 'chats'}</span>{projects.length === 0 && <Link href="/projects" onClick={onClose}>Create a project to organize chats</Link>}</footer>
      </section>
    </div>
  );
}

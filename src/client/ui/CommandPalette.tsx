import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { MessageSquare, Folder, Zap, Plug, Settings, FileText, ArrowRight } from 'lucide-react';

type IconComponent = React.ComponentType<{ size?: number | string; className?: string; }>;

interface CommandItem {
  id: string;
  label: string;
  kind: 'navigate' | 'action';
  to?: string;
  run?: () => void;
  icon: IconComponent;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [, setLocation] = useLocation();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo<CommandItem[]>(() => [
    { id: 'nav-home', label: 'New chat', kind: 'navigate', to: '/', icon: MessageSquare },
    { id: 'nav-projects', label: 'Projects', kind: 'navigate', to: '/projects', icon: Folder },
    { id: 'nav-files', label: 'Files', kind: 'navigate', to: '/files', icon: FileText },
    { id: 'nav-automations', label: 'Automation Center', kind: 'navigate', to: '/automations', icon: Zap },
    { id: 'nav-plugins', label: 'Plugins', kind: 'navigate', to: '/plugins', icon: Plug },
    { id: 'nav-settings', label: 'Settings', kind: 'navigate', to: '/settings', icon: Settings },
    { id: 'nav-incognito', label: 'Start Incognito Chat', kind: 'navigate', to: '/incognito', icon: MessageSquare },
  ], []);

  const filtered = useMemo(() => {
    if (!query) return commands;
    return commands.filter(c => c.label.toLowerCase().includes(query.toLowerCase()));
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  if (!open) return null;

  const run = (item: CommandItem) => {
    onClose();
    if (item.to) setLocation(item.to);
    else if (item.run) item.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[selected]) run(filtered[selected]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return (
    <div className="command-palette-backdrop" onClick={onClose} role="presentation">
      <div
        className="command-palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
      >
        <input
          ref={inputRef}
          className="command-palette-input"
          placeholder="Type to search commands…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Search commands"
          data-testid="input-command-search"
        />
        <div className="command-palette-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="command-empty">No matching commands.</div>
          ) : filtered.map((c, i) => {
            const Icon = c.icon;
            return (
              <div
                key={c.id}
                className={`command-item ${i === selected ? 'selected' : ''}`}
                onClick={() => run(c)}
                role="option"
                aria-selected={i === selected}
                data-testid={`command-item-${c.id}`}
                tabIndex={-1}
              >
                <Icon size={16} />
                <span className="command-label">{c.label}</span>
                <span className="command-kind">{c.kind}</span>
                <ArrowRight size={12} style={{ color: 'var(--color-text-faint)' }} />
              </div>
            );
          })}
        </div>
        <div style={{ padding: '8px 16px', fontSize: '11px', color: 'var(--color-text-faint)', borderTop: '1px solid var(--color-divider)' }}>
          ↑↓ to navigate · Enter to select · Esc to close
        </div>
      </div>
    </div>
  );
}

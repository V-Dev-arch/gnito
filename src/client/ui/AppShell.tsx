import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { MessageSquare, Folder, FileText, Zap, Plug, Settings, Search, Sun, Moon, Monitor, Menu, X, ShieldAlert } from 'lucide-react';
import { useToast } from '../lib/toast';

interface Props {
  children: React.ReactNode;
  theme: 'dark' | 'light' | 'system';
  setTheme: (t: 'dark' | 'light' | 'system') => void;
  onOpenPalette: () => void;
  incognito?: boolean;
}

const NAV = [
  { to: '/', label: 'New Chat', icon: MessageSquare },
  { to: '/projects', label: 'Projects', icon: Folder },
  { to: '/files', label: 'Files', icon: FileText },
  { to: '/automations', label: 'Automation Center', icon: Zap },
  { to: '/plugins', label: 'Plugins', icon: Plug },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function AppShell({ children, theme, setTheme, onOpenPalette, incognito }: Props) {
  const [location] = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const { push } = useToast();

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const shellClass = [
    'app-shell',
    collapsed ? 'sidebar-collapsed' : '',
    isMobile ? 'mobile' : '',
  ].filter(Boolean).join(' ');

  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;

  return (
    <div className={shellClass}>
      <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`} aria-label="Main navigation">
        <div className="sidebar-header">
          <Link href="/" className="sidebar-logo" aria-label="Gnito home">
            <img src="/brand/logo-mono.svg" alt="" width={28} height={28} style={{ color: 'currentColor' }} />
            <span className="sidebar-label" style={{ display: 'flex', flexDirection: 'column' }}>
              <span className="sidebar-wordmark">Gnito</span>
              <span className="sidebar-tagline">Your AI. Your Machine. Your Rules.</span>
            </span>
          </Link>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => isMobile ? setMobileOpen(false) : setCollapsed(c => !c)}
            aria-label={isMobile ? 'Close menu' : (collapsed ? 'Expand sidebar' : 'Collapse sidebar')}
            data-testid="button-sidebar-toggle"
          >
            {isMobile ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>

        <div className="sidebar-section">
          <button
            className="btn btn-secondary"
            onClick={onOpenPalette}
            style={{ width: '100%', justifyContent: 'flex-start' }}
            data-testid="button-command-palette"
          >
            <Search size={16} />
            <span className="sidebar-label">Search…</span>
          </button>
        </div>

        <nav className="sidebar-section">
          <div className="sidebar-section-title sidebar-label">Workspace</div>
          <div className="sidebar-nav">
            {NAV.map(({ to, label, icon: Icon }) => {
              const active = to === '/' ? location === '/' : location.startsWith(to);
              return (
                <Link
                  key={to}
                  href={to}
                  className={`sidebar-link ${active ? 'active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  data-testid={`link-${to.replace(/\//g, '-') || 'home'}`}
                >
                  <Icon size={18} />
                  <span className="sidebar-label">{label}</span>
                </Link>
              );
            })}
          </div>
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-env-status">
            <span className={`status-dot ${incognito ? 'warn' : 'ok'}`} aria-hidden />
            <span className="sidebar-label">
              {incognito ? 'Incognito active' : 'Local runtime'}
            </span>
          </div>
          <div className="sidebar-env-status">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              data-testid="button-theme-toggle"
              style={{ gap: 6, padding: '4px 8px' }}
            >
              <ThemeIcon size={14} />
              <span className="sidebar-label">{theme === 'dark' ? 'Dark' : 'Light'}</span>
            </button>
          </div>
        </div>
      </aside>

      {isMobile && mobileOpen && (
        <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} aria-hidden />
      )}

      <main style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', flex: 1 }}>
        {isMobile && !mobileOpen && (
          <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--color-divider)' }}>
            <button
              className="btn btn-ghost btn-icon"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
              data-testid="button-mobile-menu"
            >
              <Menu size={18} />
            </button>
            <span style={{ fontWeight: 700 }}>Gnito</span>
          </header>
        )}
        {incognito && (
          <div className="incognito-banner" role="status">
            <ShieldAlert size={16} />
            <span><strong>Incognito Mode</strong> — messages will not be saved to history. External providers may still process what you send.</span>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}

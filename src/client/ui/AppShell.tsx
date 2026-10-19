import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { MessageSquare, Folder, FileText, Terminal, Zap, Plug, Settings, Search, Sun, Moon, Monitor, Menu, X, ShieldAlert, EyeOff } from 'lucide-react';
import { api } from '../lib/api';

interface Props {
  children: React.ReactNode;
  theme: 'dark' | 'light' | 'system';
  setTheme: (t: 'dark' | 'light' | 'system') => void;
  onOpenPalette: () => void;
  incognito?: boolean;
}

const NAV = [
  { to: '/', label: 'New Chat', icon: MessageSquare },
  { to: '/incognito', label: 'Incognito', icon: EyeOff },
  { to: '/projects', label: 'Projects', icon: Folder },
  { to: '/files', label: 'Files', icon: FileText },
  { to: '/terminal', label: 'Terminal', icon: Terminal },
  { to: '/automations', label: 'Automation Center', icon: Zap },
  { to: '/plugins', label: 'Plugins', icon: Plug },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function AppShell({ children, theme, setTheme, onOpenPalette, incognito }: Props) {
  const [location] = useLocation();
  const [recentChats, setRecentChats] = useState<{ id: string; title: string }[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const sidebarRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const previousLocationRef = useRef(location);
  const mobileOpenRef = useRef(mobileOpen);
  mobileOpenRef.current = mobileOpen;
  const openMobileMenu = useCallback(() => {
    setMobileOpen(true);
    window.requestAnimationFrame(() => sidebarRef.current?.querySelector<HTMLElement>('a[href], button:not(:disabled)')?.focus());
  }, []);
  const closeMobileMenu = useCallback(() => {
    setMobileOpen(false);
    window.requestAnimationFrame(() => mobileMenuButtonRef.current?.focus());
  }, []);
  const trapMobileFocus = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (!isMobile || !mobileOpen || event.key !== 'Tab') return;
    const selector = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
    const focusable = Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>(selector) || [])
      .filter(element => element.getClientRects().length > 0 && element.tabIndex >= 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }, [isMobile, mobileOpen]);
  useEffect(() => {
    const sidebar = sidebarRef.current;
    const main = mainRef.current;
    if (isMobile && !mobileOpen) sidebar?.setAttribute('inert', '');
    else sidebar?.removeAttribute('inert');
    if (isMobile && mobileOpen) main?.setAttribute('inert', '');
    else main?.removeAttribute('inert');
  }, [isMobile, mobileOpen]);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  useEffect(() => {
    let alive = true;
    api.get('/api/chats?status=active').then((chats: { id: string; title: string }[]) => {
      if (alive) setRecentChats(chats.slice(0, 8));
    }).catch(() => { if (alive) setRecentChats([]); });
    api.get('/api/health').then(() => { if (alive) setRuntimeStatus('online'); }).catch(() => { if (alive) setRuntimeStatus('offline'); });
    return () => { alive = false; };
  }, [location]);
  useEffect(() => {
    if (previousLocationRef.current === location) return;
    previousLocationRef.current = location;
    if (mobileOpenRef.current) closeMobileMenu();
  }, [location, closeMobileMenu]);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && mobileOpen) closeMobileMenu(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [mobileOpen, closeMobileMenu]);

  const shellClass = [
    'app-shell',
    collapsed ? 'sidebar-collapsed' : '',
    isMobile ? 'mobile' : '',
  ].filter(Boolean).join(' ');

  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  const pageTitle = location.startsWith('/incognito') ? 'Incognito chat' : location.startsWith('/chats') ? 'Chat' : NAV.find(n => n.to !== '/' && location.startsWith(n.to))?.label || 'Gnito';

  return (
    <div className={shellClass}>
      <aside
        ref={sidebarRef}
        id="primary-navigation"
        className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}
        aria-label="Main navigation"
        aria-hidden={isMobile && !mobileOpen}
        onKeyDown={trapMobileFocus}
      >
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
            onClick={() => isMobile ? closeMobileMenu() : setCollapsed(c => !c)}
            aria-label={isMobile ? 'Close menu' : (collapsed ? 'Expand sidebar' : 'Collapse sidebar')}
            aria-expanded={isMobile ? mobileOpen : !collapsed}
            aria-controls="primary-navigation"
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
                  onClick={() => { if (isMobile) closeMobileMenu(); }}
                  data-testid={`link-${to.replace(/\//g, '-') || 'home'}`}
                >
                  <Icon size={18} />
                  <span className="sidebar-label">{label}</span>
                </Link>
              );
            })}
          </div>
        </nav>

        <section className="sidebar-section recent-chats" aria-label="Recent conversations">
          <div className="sidebar-section-title sidebar-label">Recent</div>
          <div className="sidebar-nav">
            {recentChats.map(chat => (
              <Link key={chat.id} href={`/chats/${chat.id}`} className={`sidebar-link sidebar-chat-link ${location === `/chats/${chat.id}` ? 'active' : ''}`} onClick={() => setMobileOpen(false)} title={chat.title}>
                <MessageSquare size={16} /><span className="sidebar-label">{chat.title}</span>
              </Link>
            ))}
          </div>
        </section>

        <div className="sidebar-footer">
          <div className="sidebar-env-status">
            <span className={`status-dot ${incognito ? 'warn' : runtimeStatus}`} aria-hidden />
            <span className="sidebar-label" role="status" aria-live="polite">
              {incognito ? 'Incognito active' : runtimeStatus === 'online' ? 'Workspace online' : runtimeStatus === 'offline' ? 'Workspace offline' : 'Checking workspace…'}
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
        <button className="sidebar-backdrop" onClick={closeMobileMenu} aria-label="Close navigation" />
      )}

      <main
        className="app-main"
        ref={mainRef}
        style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', flex: 1 }}
        aria-hidden={isMobile && mobileOpen}
      >
        {isMobile && !mobileOpen && (
          <header className="mobile-topbar" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--color-divider)' }}>
            <button
              className="btn btn-ghost btn-icon"
              ref={mobileMenuButtonRef}
              onClick={openMobileMenu}
              aria-label="Open navigation"
              aria-expanded={mobileOpen}
              aria-controls="primary-navigation"
              data-testid="button-mobile-menu"
            >
              <Menu size={18} />
            </button>
            <span style={{ fontWeight: 700 }}>{pageTitle}</span>
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

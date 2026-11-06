import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { Activity, CalendarClock, Command, EyeOff, FileText, Folder, LayoutPanelTop, Menu, MessagesSquare, Moon, PanelLeftClose, PanelLeftOpen, Plug, Search, Settings, SlidersHorizontal, Sun, Terminal, X, Zap } from 'lucide-react';
import { api } from '../lib/api';
import { MyChatsDialog } from '../features/chat/MyChatsDialog';

interface Props { children: React.ReactNode; theme: 'dark' | 'light' | 'system'; setTheme: (t: 'dark' | 'light' | 'system') => void; onOpenPalette: () => void; incognito?: boolean }

type NavItem = { to: string; label: string; icon: React.ComponentType<any> };
const NAV: NavItem[] = [
  { to: '/', label: 'New Chat', icon: Command },
  { to: '/incognito', label: 'Incognito', icon: EyeOff },
  { to: '/projects', label: 'Projects', icon: Folder },
  { to: '/files', label: 'Files', icon: FileText },
  { to: '/terminal', label: 'Terminal', icon: Terminal },
  { to: '/automations', label: 'Automation Center', icon: Zap },
  { to: '/plugins', label: 'Plugins', icon: Plug },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function AppShell({ children, theme, setTheme, onOpenPalette, incognito }: Props) {
  const [location, setLocation] = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(() => window.localStorage.getItem('gnito-rail-collapsed') === '1');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [myChatsOpen, setMyChatsOpen] = useState(false);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const drawerRef = useRef<HTMLElement>(null);
  const mobileButtonRef = useRef<HTMLButtonElement>(null);
  const myChatsRef = useRef<HTMLButtonElement>(null);
  const scheduledRef = useRef<HTMLButtonElement>(null);

  const pageTitle = location.startsWith('/incognito') ? 'Incognito' : location.startsWith('/chats') ? 'Conversation' : NAV.find(item => item.to !== '/' && location.startsWith(item.to))?.label || 'Command deck';
  const chatId = location.startsWith('/chats/') ? location.slice('/chats/'.length).split('/')[0] : undefined;

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    window.requestAnimationFrame(() => mobileButtonRef.current?.focus());
  }, []);
  const openDrawer = useCallback(() => {
    setDrawerOpen(true);
    window.requestAnimationFrame(() => drawerRef.current?.querySelector<HTMLElement>('a[href],button:not(:disabled)')?.focus());
  }, []);

  useEffect(() => {
    const resize = () => setIsMobile(window.innerWidth <= 820);
    resize(); window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => { window.localStorage.setItem('gnito-rail-collapsed', railCollapsed ? '1' : '0'); }, [railCollapsed]);
  useEffect(() => {
    let alive = true;
    api.get('/api/health').then(() => alive && setRuntimeStatus('online')).catch(() => alive && setRuntimeStatus('offline'));
    return () => { alive = false; };
  }, [location]);
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setDrawerOpen(false); setInspectorOpen(false); } };
    const onDialog = (event: Event) => { const mode = (event as CustomEvent<'chats' | 'scheduled'>).detail; if (mode === 'chats') setMyChatsOpen(true); if (mode === 'scheduled') setScheduledOpen(true); };
    window.addEventListener('keydown', onEscape); window.addEventListener('gnito:open-dialog', onDialog);
    return () => { window.removeEventListener('keydown', onEscape); window.removeEventListener('gnito:open-dialog', onDialog); };
  }, []);
  useEffect(() => { if (isMobile && drawerOpen) document.body.dataset.drawerOpen = '1'; else delete document.body.dataset.drawerOpen; }, [isMobile, drawerOpen]);

  const active = (to: string) => to === '/' ? location === '/' : location.startsWith(to);
  const actualTheme = theme === 'light' ? 'light' : 'dark';

  return <div className={`nexus-shell ${railCollapsed && !isMobile ? 'rail-collapsed' : ''} ${inspectorOpen && !isMobile ? 'inspector-open' : ''}`}>
    <aside className="nexus-rail" aria-label="Gnito navigation rail">
      <Link href="/" className="nexus-brand" aria-label="Gnito command deck"><span className="nexus-brand-g">G</span><span className="nexus-brand-name">gnito</span></Link>
      <div className="nexus-rail-group">
        {NAV.map(({ to, label, icon: Icon }) => <Link key={to} href={to} className={`nexus-rail-button ${active(to) ? 'active' : ''}`} aria-label={label} aria-current={active(to) ? 'page' : undefined} data-testid={`link-rail-${to.replace(/\//g, '-') || 'home'}`}><Icon size={17} strokeWidth={1.7} /><span>{label}</span></Link>)}
        <button className="nexus-rail-button" onClick={() => setMyChatsOpen(true)} ref={myChatsRef} aria-label="My Chats" data-testid="button-my-chats"><MessagesSquare size={17} strokeWidth={1.7} /><span>My Chats</span></button>
        <button className="nexus-rail-button" onClick={() => setScheduledOpen(true)} ref={scheduledRef} aria-label="Scheduled Tasks" data-testid="button-scheduled-tasks"><CalendarClock size={17} strokeWidth={1.7} /><span>Scheduled Tasks</span></button>
      </div>
      <div className="nexus-rail-bottom">
        <button className="nexus-rail-button" onClick={() => setInspectorOpen(value => !value)} aria-label="Toggle inspector" aria-pressed={inspectorOpen} data-testid="button-context-panel"><SlidersHorizontal size={17} strokeWidth={1.7} /><span>Inspector</span></button>
        <button className="nexus-rail-button" onClick={() => setTheme(actualTheme === 'dark' ? 'light' : 'dark')} aria-label="Toggle theme" data-testid="button-theme-toggle">{actualTheme === 'dark' ? <Moon size={17} strokeWidth={1.7} /> : <Sun size={17} strokeWidth={1.7} />}<span>Theme</span></button>
        <div className="nexus-status" title={runtimeStatus}><span className={`nexus-status-dot ${runtimeStatus}`} /><span>{runtimeStatus === 'online' ? 'ONLINE' : runtimeStatus === 'offline' ? 'OFFLINE' : 'SYNC'}</span></div>
        <button className="nexus-collapse" onClick={() => setRailCollapsed(value => !value)} aria-label={railCollapsed ? 'Expand navigation' : 'Collapse navigation'} data-testid="button-sidebar-collapse">{railCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
      </div>
    </aside>

    <aside className={`nexus-drawer ${drawerOpen ? 'open' : ''}`} ref={drawerRef} aria-label="Workspace navigation" aria-hidden={isMobile && !drawerOpen}>
      <div className="nexus-drawer-header"><div><div className="nexus-overline">GNITO / NEXUS</div><strong>{pageTitle}</strong></div>{isMobile && <button className="nexus-icon-button" onClick={closeDrawer} aria-label="Close navigation"><X size={17} /></button>}</div>
      <button className="nexus-command-trigger" onClick={onOpenPalette} data-testid="button-command-palette"><Search size={15} /><span>Search commands</span><kbd>⌘ K</kbd></button>
      <div className="nexus-drawer-section"><div className="nexus-drawer-label">Active workspace</div><div className="nexus-workspace-card"><Activity size={15} /><div><strong>Local node</strong><span>Personal developer OS</span></div><span className="nexus-live-dot" /></div></div>
      <div className="nexus-drawer-section nexus-recents"><div className="nexus-drawer-label">Navigation</div><div className="nexus-drawer-links">{NAV.map(({ to, label, icon: Icon }) => <Link key={to} href={to} className={`nexus-drawer-link ${active(to) ? 'active' : ''}`} data-testid={`link-drawer-${to.replace(/\//g, '-') || 'home'}`}><Icon size={15} /><span>{label}</span></Link>)}<button className="nexus-drawer-link" onClick={() => setMyChatsOpen(true)}><MessagesSquare size={15} /><span>My Chats</span></button><button className="nexus-drawer-link" onClick={() => setScheduledOpen(true)}><CalendarClock size={15} /><span>Scheduled Tasks</span></button></div></div>
      <div className="nexus-drawer-footer"><span>Workspace {runtimeStatus}</span><span className="nexus-footer-key">LOCAL / BYOK</span></div>
    </aside>

    {isMobile && drawerOpen && <button className="nexus-backdrop" onClick={closeDrawer} aria-label="Close navigation" />}
    <main className="nexus-canvas">
      <header className="nexus-topbar"><div className="nexus-topbar-left"><button className="nexus-mobile-menu" ref={mobileButtonRef} onClick={openDrawer} aria-label="Open navigation"><Menu size={18} /></button><div className="nexus-breadcrumb"><span>NODE / 01</span><i>/</i><strong>{pageTitle}</strong></div></div><div className="nexus-topbar-actions"><span className="nexus-system-readout"><span className="nexus-live-dot" /> {incognito ? 'PRIVATE SESSION' : 'SYSTEM NOMINAL'}</span><button className="nexus-topbar-command" onClick={onOpenPalette}><Command size={14} /><span>Command center</span><kbd>⌘ K</kbd></button></div></header>
      {incognito && <div className="nexus-incognito-banner"><EyeOff size={14} /><span>Incognito channel active. Messages will not be saved to local history.</span></div>}
      <div className="nexus-content">{children}</div>
    </main>

    {inspectorOpen && !isMobile && <aside className="nexus-inspector" aria-label="Context inspector"><div className="nexus-inspector-head"><div><div className="nexus-overline">CONTEXT / LIVE</div><h2>{pageTitle}</h2></div><button className="nexus-icon-button" onClick={() => setInspectorOpen(false)} aria-label="Close inspector"><X size={16} /></button></div><div className="nexus-inspector-block"><span className="nexus-drawer-label">Runtime</span><strong><span className="nexus-live-dot" /> {runtimeStatus === 'online' ? 'Workspace online' : 'Checking workspace'}</strong><p>Local APIs, storage and provider configuration are available to the current session.</p></div><div className="nexus-inspector-block"><span className="nexus-drawer-label">Control surface</span><div className="nexus-inspector-row"><span>Command center</span><kbd>⌘ K</kbd></div><div className="nexus-inspector-row"><span>Navigation</span><span>Rail + drawer</span></div><div className="nexus-inspector-row"><span>Theme</span><span>{actualTheme}</span></div></div><div className="nexus-inspector-scan"><LayoutPanelTop size={15} /><span>Inspector is optional. Close it for a clean canvas.</span></div></aside>}

    <MyChatsDialog open={myChatsOpen} currentChatId={chatId} onClose={() => { setMyChatsOpen(false); window.requestAnimationFrame(() => myChatsRef.current?.focus()); }} onDeleted={id => { if (chatId === id) setLocation('/'); }} />
    <MyChatsDialog open={scheduledOpen} mode="scheduled" currentChatId={chatId} onClose={() => { setScheduledOpen(false); window.requestAnimationFrame(() => scheduledRef.current?.focus()); }} onDeleted={id => { if (chatId === id) setLocation('/'); }} />
  </div>;
}

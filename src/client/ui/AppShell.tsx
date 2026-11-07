import React, { useCallback, useEffect, useState } from 'react';
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem('gnito-sidebar-collapsed') === '1');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [myChatsOpen, setMyChatsOpen] = useState(false);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const actualTheme = theme === 'light' ? 'light' : 'dark';
  const pageTitle = location.startsWith('/incognito') ? 'Incognito' : location.startsWith('/chats') ? 'Conversation' : NAV.find(item => item.to !== '/' && location.startsWith(item.to))?.label || 'Command deck';
  const chatId = location.startsWith('/chats/') ? location.slice('/chats/'.length).split('/')[0] : undefined;

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const navigate = useCallback(() => { if (isMobile) setSidebarOpen(false); }, [isMobile]);

  useEffect(() => {
    const resize = () => setIsMobile(window.innerWidth <= 820);
    resize(); window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => { window.localStorage.setItem('gnito-sidebar-collapsed', sidebarCollapsed ? '1' : '0'); }, [sidebarCollapsed]);
  useEffect(() => {
    let alive = true;
    api.get('/api/health').then(() => alive && setRuntimeStatus('online')).catch(() => alive && setRuntimeStatus('offline'));
    return () => { alive = false; };
  }, [location]);
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setSidebarOpen(false); setInspectorOpen(false); } };
    const onDialog = (event: Event) => { const mode = (event as CustomEvent<'chats' | 'scheduled'>).detail; if (mode === 'chats') setMyChatsOpen(true); if (mode === 'scheduled') setScheduledOpen(true); };
    window.addEventListener('keydown', onEscape); window.addEventListener('gnito:open-dialog', onDialog);
    return () => { window.removeEventListener('keydown', onEscape); window.removeEventListener('gnito:open-dialog', onDialog); };
  }, []);
  useEffect(() => { document.body.dataset.drawerOpen = isMobile && sidebarOpen ? '1' : ''; return () => { delete document.body.dataset.drawerOpen; }; }, [isMobile, sidebarOpen]);

  const active = (to: string) => to === '/' ? location === '/' : location.startsWith(to);
  const sidebarClass = `nexus-sidebar ${sidebarOpen ? 'open' : ''}`;

  return <div className={`nexus-shell ${sidebarCollapsed && !isMobile ? 'sidebar-collapsed' : ''} ${inspectorOpen && !isMobile ? 'inspector-open' : ''}`}>
    <aside className={sidebarClass} aria-label="Gnito navigation" aria-hidden={isMobile && !sidebarOpen}>
      <div className="nexus-sidebar-header">
        <Link href="/" className="nexus-brand" aria-label="Gnito command deck" onClick={navigate}><span className="nexus-brand-g">G</span><span className="nexus-brand-copy"><strong>gnito</strong><small>NEXUS / LOCAL AI</small></span></Link>
        {isMobile && <button className="nexus-icon-button" onClick={closeSidebar} aria-label="Close navigation"><X size={17} /></button>}
        {!isMobile && <button className="nexus-icon-button nexus-sidebar-toggle" onClick={() => setSidebarCollapsed(value => !value)} aria-label={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}>{sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>}
      </div>
      <button className="nexus-command-trigger" onClick={onOpenPalette} data-testid="button-command-palette"><Search size={15} /><span>Search commands</span><kbd>⌘ K</kbd></button>
      <div className="nexus-sidebar-body">
        <div className="nexus-drawer-section"><div className="nexus-drawer-label">Active workspace</div><div className="nexus-workspace-card"><Activity size={15} /><div><strong>Local node</strong><span>Personal developer OS</span></div><span className="nexus-live-dot" /></div></div>
        <div className="nexus-drawer-section nexus-recents"><div className="nexus-drawer-label">Navigation</div><div className="nexus-drawer-links">{NAV.map(({ to, label, icon: Icon }) => <Link key={to} href={to} onClick={navigate} className={`nexus-drawer-link ${active(to) ? 'active' : ''}`} aria-current={active(to) ? 'page' : undefined} data-testid={`link-drawer-${to.replace(/\//g, '-') || 'home'}`}><Icon size={15} /><span>{label}</span></Link>)}<button className="nexus-drawer-link" onClick={() => { setMyChatsOpen(true); closeSidebar(); }}><MessagesSquare size={15} /><span>My Chats</span></button><button className="nexus-drawer-link" onClick={() => { setScheduledOpen(true); closeSidebar(); }}><CalendarClock size={15} /><span>Scheduled Tasks</span></button></div></div>
      </div>
      <div className="nexus-sidebar-footer"><div className="nexus-sidebar-tools"><button className="nexus-drawer-link" onClick={() => setInspectorOpen(value => !value)} aria-pressed={inspectorOpen}><SlidersHorizontal size={15} /><span>Inspector</span></button><button className="nexus-drawer-link" onClick={() => setTheme(actualTheme === 'dark' ? 'light' : 'dark')}><span>{actualTheme === 'dark' ? <Moon size={15} /> : <Sun size={15} />}</span><span>Theme</span></button></div><div className="nexus-sidebar-status"><span className={`nexus-status-dot ${runtimeStatus}`} /><span>{runtimeStatus === 'online' ? 'ONLINE' : runtimeStatus === 'offline' ? 'OFFLINE' : 'SYNC'}</span><span className="nexus-footer-key">LOCAL / BYOK</span></div></div>
    </aside>

    {isMobile && sidebarOpen && <button className="nexus-backdrop" onClick={closeSidebar} aria-label="Close navigation" />}
    <main className="nexus-canvas">
      <header className="nexus-topbar"><div className="nexus-topbar-left"><button className="nexus-mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open navigation"><Menu size={18} /></button><div className="nexus-breadcrumb"><span>NODE / 01</span><i>/</i><strong>{pageTitle}</strong></div></div><div className="nexus-topbar-actions"><span className="nexus-system-readout"><span className="nexus-live-dot" /> {incognito ? 'PRIVATE SESSION' : 'SYSTEM NOMINAL'}</span><button className="nexus-topbar-command" onClick={onOpenPalette}><Command size={14} /><span>Command center</span><kbd>⌘ K</kbd></button></div></header>
      {incognito && <div className="nexus-incognito-banner"><EyeOff size={14} /><span>Incognito channel active. Messages will not be saved to local history.</span></div>}
      <div className="nexus-content">{children}</div>
    </main>

    {inspectorOpen && !isMobile && <aside className="nexus-inspector" aria-label="Context inspector"><div className="nexus-inspector-head"><div><div className="nexus-overline">CONTEXT / LIVE</div><h2>{pageTitle}</h2></div><button className="nexus-icon-button" onClick={() => setInspectorOpen(false)} aria-label="Close inspector"><X size={16} /></button></div><div className="nexus-inspector-block"><span className="nexus-drawer-label">Runtime</span><strong><span className="nexus-live-dot" /> {runtimeStatus === 'online' ? 'Workspace online' : 'Checking workspace'}</strong><p>Local APIs, storage and provider configuration are available to the current session.</p></div><div className="nexus-inspector-block"><span className="nexus-drawer-label">Control surface</span><div className="nexus-inspector-row"><span>Command center</span><kbd>⌘ K</kbd></div><div className="nexus-inspector-row"><span>Navigation</span><span>Unified sidebar</span></div><div className="nexus-inspector-row"><span>Theme</span><span>{actualTheme}</span></div></div><div className="nexus-inspector-scan"><LayoutPanelTop size={15} /><span>Inspector is optional. Close it for a clean canvas.</span></div></aside>}

    <MyChatsDialog open={myChatsOpen} currentChatId={chatId} onClose={() => setMyChatsOpen(false)} onDeleted={id => { if (chatId === id) setLocation('/'); }} />
    <MyChatsDialog open={scheduledOpen} mode="scheduled" currentChatId={chatId} onClose={() => setScheduledOpen(false)} onDeleted={id => { if (chatId === id) setLocation('/'); }} />
  </div>;
}

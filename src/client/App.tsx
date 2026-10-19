import React, { useEffect, useState, useCallback } from 'react';
import { Switch, Route, Router } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { ToastProvider } from './lib/toast';
import { api, setSession, hasSession } from './lib/api';
import { AppShell } from './ui/AppShell';
import { ChatPage } from './features/chat/ChatPage';
import { IncognitoPage } from './features/incognito/IncognitoPage';
import { AutomationsPage } from './features/automations/AutomationsPage';
import { PluginsPage } from './features/plugins/PluginsPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { ProjectsPage } from './features/projects/ProjectsPage';
import { FilesPage } from './features/files/FilesPage';
import { TerminalPage } from './features/terminal/TerminalPage';
import { CommandPalette } from './ui/CommandPalette';
import { NotFoundPage } from './ui/NotFoundPage';

// ------------------------------------------------------------- theme

  type Theme = 'dark' | 'light' | 'system';

function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = typeof window !== 'undefined' ? window.__gnitoTheme : null;
    return saved || 'dark';
  });

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    if (typeof window !== 'undefined') {
      window.__gnitoTheme = t;
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const actual = t === 'system' ? (prefersDark ? 'dark' : 'light') : t;
      document.documentElement.setAttribute('data-theme', actual);
    }
  }, []);

  useEffect(() => {
    // On first mount, apply.
    setTheme(theme);
    // Listen for system changes if in system mode.
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => { if (theme === 'system') setTheme('system'); };
    mq.addEventListener('change', listener);
    return () => mq.removeEventListener('change', listener);
  }, [theme]);

  return { theme, setTheme };
}

declare global {
  interface Window { __gnitoTheme?: Theme }
}

// --------------------------------------------------------------- app

function AppInner() {
  const [ready, setReady] = useState(false);
  const [sessionErr, setSessionErr] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { theme, setTheme } = useTheme();

  // Bootstrap session.
  useEffect(() => {
    if (hasSession()) { setReady(true); return; }
    api.post('/api/session')
      .then((r: any) => {
        setSession(r.token, r.csrf);
        setReady(true);
      })
      .catch(e => {
        setSessionErr(e.message);
        setReady(true);
      });
  }, []);

  // Command palette shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(o => !o);
      }
      if (e.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!ready) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100dvh' }}>
        <div className="streaming-indicator">
          <div className="dots"><span className="dot" /><span className="dot" /><span className="dot" /></div>
          <span>Starting Gnito…</span>
        </div>
      </div>
    );
  }

  if (sessionErr) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">Gnito could not start</div>
        <div className="empty-state-text">{sessionErr}</div>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>Retry</button>
      </div>
    );
  }

  return (
    <>
      <Router hook={useHashLocation}>
        <Switch>
          <Route path="/" component={() => (
            <AppShell theme={theme} setTheme={setTheme} onOpenPalette={() => setPaletteOpen(true)}>
              <ChatPage />
            </AppShell>
          )} />
          <Route path="/incognito" component={() => (
            <AppShell theme={theme} setTheme={setTheme} onOpenPalette={() => setPaletteOpen(true)} incognito>
              <IncognitoPage />
            </AppShell>
          )} />
          <Route path="/chats/:id" component={({ params }) => (
            <AppShell theme={theme} setTheme={setTheme} onOpenPalette={() => setPaletteOpen(true)}>
              <ChatPage chatId={params.id} />
            </AppShell>
          )} />
          <Route path="/projects" component={() => (
            <AppShell theme={theme} setTheme={setTheme} onOpenPalette={() => setPaletteOpen(true)}>
              <ProjectsPage />
            </AppShell>
          )} />
          <Route path="/projects/:id" component={({ params }) => (
            <AppShell theme={theme} setTheme={setTheme} onOpenPalette={() => setPaletteOpen(true)}>
              <ChatPage projectId={params.id} />
            </AppShell>
          )} />
          <Route path="/files" component={() => (
            <AppShell theme={theme} setTheme={setTheme} onOpenPalette={() => setPaletteOpen(true)}>
              <FilesPage />
            </AppShell>
          )} />
          <Route path="/terminal" component={() => (
            <AppShell theme={theme} setTheme={setTheme} onOpenPalette={() => setPaletteOpen(true)}>
              <TerminalPage />
            </AppShell>
          )} />
          <Route path="/automations" component={() => (
            <AppShell theme={theme} setTheme={setTheme} onOpenPalette={() => setPaletteOpen(true)}>
              <AutomationsPage />
            </AppShell>
          )} />
          <Route path="/plugins" component={() => (
            <AppShell theme={theme} setTheme={setTheme} onOpenPalette={() => setPaletteOpen(true)}>
              <PluginsPage />
            </AppShell>
          )} />
          <Route path="/settings" component={() => (
            <AppShell theme={theme} setTheme={setTheme} onOpenPalette={() => setPaletteOpen(true)}>
              <SettingsPage />
            </AppShell>
          )} />
          <Route component={NotFoundPage} />
        </Switch>
      </Router>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}

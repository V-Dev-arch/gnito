import React, { useEffect, useRef, useState } from 'react';
import { Send, ShieldAlert, EyeOff, LogOut } from 'lucide-react';
import { api } from '../../lib/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface IncMessage { id: string; role: 'user' | 'assistant'; content: string; createdAt: number }

export function IncognitoPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<IncMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    api.post('/api/incognito/start').then((r: any) => {
      setSessionId(r.sessionId);
      sessionIdRef.current = r.sessionId;
    });
    return () => {
      const sid = sessionIdRef.current;
      if (sid) api.post(`/api/incognito/${sid}/exit`).catch(() => {});
    };
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streamedText]);

  // NOTE: this first iteration routes incognito messages through the
  // in-memory session only (no persistence). We do not yet call the
  // provider from incognito (would need a temp session). We show a
  // disclosure that messages stay in memory until exit.
  const send = async () => {
    const content = input.trim();
    if (!content || !sessionId) return;
    const userMsg: IncMessage = { id: `u-${Date.now()}`, role: 'user', content, createdAt: Date.now() };
    setMessages(m => [...m, userMsg]);
    setInput('');
    setStreaming(true);
    setStreamedText('');
    try {
      // Save to incognito in-memory session.
      await api.post(`/api/incognito/${sessionId}/message`, { role: 'user', content });
      // Real provider streaming in Incognito is not wired yet; show a clear
      // disclosure (not a fake response) and document the limitation.
      setStreamedText([
        '> **Incognito notice**',
        '>',
        '> Messages in this session are stored only in memory and will be discarded when you exit.',
        'External model providers may still process what you send — incognito does not provide anonymity.',
        '',
        'Live model responses in Incognito Mode are not wired up in this build yet. Your message was',
        'stored temporarily in memory (not on disk) and will be discarded when you exit.',
      ].join('\n'));
      setStreaming(false);
    } catch (e: any) {
      setError(e.message);
      setStreaming(false);
    }
  };

  const exit = async () => {
    if (!sessionId) return;
    await api.post(`/api/incognito/${sessionId}/exit`).catch(() => {});
    setSessionId(null);
    setMessages([]);
    setStreamedText('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div className="chat-container">
        <div className="chat-header">
          <div>
            <h1 className="chat-title"><EyeOff size={20} style={{ display: 'inline', marginRight: 8, verticalAlign: 'text-bottom' }} />Incognito Chat</h1>
            <div className="composer-meta">
              <span>Temporary session · nothing is saved</span>
            </div>
          </div>
          <button className="btn btn-secondary" onClick={exit} data-testid="button-exit-incognito">
            <LogOut size={14} /> Exit Incognito
          </button>
        </div>

        <div className="automation-warning" role="status">
          <ShieldAlert size={16} />
          <span>
            Incognito Mode prevents <strong>local</strong> history and memory persistence. It does
            <strong> not</strong> make you anonymous to external services. Messages will be discarded on exit.
          </span>
        </div>

        {messages.length === 0 && (
          <div className="empty-state">
            <EyeOff size={44} style={{ color: 'var(--color-warning)', margin: '0 auto 16px' }} />
            <div className="empty-state-title">Temporary private chat</div>
            <div className="empty-state-text">
              Messages stay in memory only. When you exit, they're gone.
            </div>
          </div>
        )}

        <div className="chat-messages">
          {messages.map(m => (
            <div key={m.id} className={`message ${m.role}`} data-testid={`inc-message-${m.id}`}>
              <div className="message-role">{m.role === 'user' ? 'You' : 'Gnito'}</div>
              <div className="message-content markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
              </div>
            </div>
          ))}
          {streaming && (
            <div className="message assistant">
              <div className="message-role">Gnito</div>
              <div className="message-content markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamedText}</ReactMarkdown>
              </div>
            </div>
          )}
          {error && <div className="card" style={{ borderColor: 'var(--color-error)' }}><div className="card-title" style={{ color: 'var(--color-error)' }}>{error}</div></div>}
          <div ref={endRef} />
        </div>
      </div>

      <div className="composer">
        <div className="composer-inner">
          <div className="composer-input-row">
            <textarea
              className="composer-textarea"
              placeholder="Ask Gnito (temporary)…"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              aria-label="Incognito message"
              data-testid="input-incognito-message"
              rows={1}
            />
            <button className="composer-send" onClick={send} disabled={!input.trim()} data-testid="button-incognito-send">
              <Send size={14} /> Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Link, useLocation } from 'wouter';
import { Send, Square, Copy, Trash2, Plus, RefreshCw, Paperclip, Mic, Sparkles, Search as SearchIcon } from 'lucide-react';
import { api, setSession } from '../../lib/api';
import { useToast } from '../../lib/toast';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Provider {
  id: string; label: string; baseUrl: string; enabled: boolean; kind: string; hasKey: boolean;
}
interface Message { id: string; role: 'user' | 'assistant'; content: string; createdAt?: number }
interface Chat { id: string; title: string; projectId: string | null; status: string }

interface Props { chatId?: string; projectId?: string }

export function ChatPage({ chatId, projectId }: Props) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [chatInfo, setChatInfo] = useState<Chat | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { push } = useToast();
  const [, setLocation] = useLocation();

  // Load providers.
  useEffect(() => {
    api.get('/api/providers').then((ps: Provider[]) => {
      const enabled = ps.filter(p => p.enabled);
      setProviders(ps);
      if (enabled.length > 0) setSelectedProvider(enabled[0].id);
    }).catch(e => setError(e.message));
  }, []);

  // Load chat.
  useEffect(() => {
    if (!chatId) return;
    api.get(`/api/chats/${chatId}`).then((r: any) => {
      setChatInfo(r.chat);
      setMessages(r.messages.filter((m: any) => m.role === 'user' || m.role === 'assistant'));
    }).catch(e => setError(e.message));
  }, [chatId]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streamedText]);

  const createChat = async (): Promise<string> => {
    const r = await api.post('/api/chats', { title: 'New chat', projectId: projectId ?? null });
    return r.id;
  };

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content || streaming) return;
    if (!selectedProvider) { push('Add a provider in Settings first.', 'error'); return; }
    if (!selectedModel) { push('Select a model.', 'error'); return; }

    let cid = chatId;
    if (!cid) {
      try { cid = await createChat(); setLocation(`/chats/${cid}`); } catch (e: any) { setError(e.message); return; }
    }

    const userMsg: Message = { id: `tmp-${Date.now()}`, role: 'user', content };
    setMessages(m => [...m, userMsg]);
    setInput('');
    setStreaming(true);
    setStreamedText('');
    setError(null);

    // Save user message to backend.
    api.post(`/api/chats/${cid}/messages`, { role: 'user', content }).catch(() => {});

    // Stream response. The api client passes the authoritative final text.
    const priorMessages = messages.map(m => ({ role: m.role, content: m.content }));
    abortRef.current = api.streamChat(
      selectedProvider,
      {
        model: selectedModel,
        messages: [...priorMessages, { role: 'user', content }],
        stream: true,
      },
      (delta) => setStreamedText(t => t + delta),
      (finalText: string) => {
        setStreaming(false);
        if (finalText) {
          const assistantMsg: Message = { id: `a-${Date.now()}`, role: 'assistant', content: finalText };
          setMessages(m => [...m, assistantMsg]);
          if (cid) api.post(`/api/chats/${cid}/messages`, { role: 'assistant', content: finalText }).catch(() => {});
        }
        setStreamedText('');
      },
      (msg) => {
        setStreaming(false);
        setError(msg);
      },
    );
  }, [input, streaming, selectedProvider, selectedModel, chatId, messages, projectId]);

  const stop = () => {
    abortRef.current?.abort();
    setStreaming(false);
    setStreamedText(t => {
      if (t) {
        const assistantMsg: Message = { id: `a-${Date.now()}`, role: 'assistant', content: t + '\n\n_[stopped]_' };
        setMessages(m => [...m, assistantMsg]);
      }
      return '';
    });
  };

  const enabledProviders = providers.filter(p => p.enabled);
  const needsSetup = enabledProviders.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div className="chat-container">
        <div className="chat-header">
          <div>
            <h1 className="chat-title" data-testid="text-chat-title">{chatInfo?.title || 'New chat'}</h1>
            <div className="composer-meta">
              <span>{enabledProviders.length} provider{enabledProviders.length === 1 ? '' : 's'} · local-first</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Link href="/" className="btn btn-ghost btn-sm" data-testid="button-new-chat">
              <Plus size={14} /> New chat
            </Link>
          </div>
        </div>

        {needsSetup && !streaming && (
          <div className="card" style={{ marginBottom: 16 }} data-testid="setup-card">
            <div className="card-title">Welcome to Gnito</div>
            <div className="card-description">
              Gnito is a local-first AI workspace. Add a model provider (bring your own API key) to start chatting.
              Your data stays on this machine.
            </div>
            <Link href="/settings" className="btn btn-primary" data-testid="button-setup-provider">Add a provider</Link>
          </div>
        )}

        {messages.length === 0 && !streaming && !needsSetup && (
          <div className="empty-state">
            <img src="/brand/logo-mono.svg" alt="" width={48} height={48} style={{ color: 'var(--color-primary)' }} />
            <div className="empty-state-title">How can Gnito help?</div>
            <div className="empty-state-text">Ask anything. Gnito will use your chosen model and save the conversation locally.</div>
            <div className="empty-state-actions">
              {[
                { title: 'Explain a concept', desc: 'Get a clear explanation of any topic' },
                { title: 'Summarize a file', desc: 'Pick an approved folder and summarize a file' },
                { title: 'Search the web', desc: 'Find current information from the web' },
                { title: 'Create an automation', desc: 'Schedule a recurring task' },
              ].map(s => (
                <button
                  key={s.title}
                  className="suggestion-card"
                  onClick={() => setInput(s.title)}
                  data-testid={`suggestion-${s.title.toLowerCase().replace(/\s+/g, '-')}`}
                >
                  <div className="suggestion-title">{s.title}</div>
                  <div className="suggestion-desc">{s.desc}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="chat-messages" data-testid="chat-messages">
          {messages.map(m => (
            <div key={m.id} className={`message ${m.role}`} data-testid={`message-${m.id}`}>
              <div className="message-role">
                {m.role === 'user' ? 'You' : 'Gnito'}
              </div>
              <div className="message-content markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
              </div>
              <div className="message-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => { navigator.clipboard.writeText(m.content); push('Copied', 'success'); }}
                  aria-label="Copy message"
                  data-testid={`button-copy-${m.id}`}
                >
                  <Copy size={12} /> Copy
                </button>
                {m.role === 'user' && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setInput(m.content)}
                    aria-label="Edit and resend"
                    data-testid={`button-edit-${m.id}`}
                  >
                    <RefreshCw size={12} /> Edit
                  </button>
                )}
              </div>
            </div>
          ))}

          {streaming && (
            <div className="message assistant" data-testid="message-streaming">
              <div className="message-role">Gnito</div>
              <div className="message-content markdown">
                {streamedText ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamedText}</ReactMarkdown> : (
                  <div className="streaming-indicator">
                    <div className="dots"><span className="dot" /><span className="dot" /><span className="dot" /></div>
                    <span>Generating…</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="card" style={{ borderColor: 'var(--color-error)' }} data-testid="chat-error">
              <div className="card-title" style={{ color: 'var(--color-error)' }}>Request failed</div>
              <div className="card-description">{error}</div>
              <button className="btn btn-secondary" onClick={() => setError(null)}>Dismiss</button>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="composer">
        <div className="composer-inner">
          <div className="composer-input-row">
            <textarea
              className="composer-textarea"
              placeholder="Ask Gnito…"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              aria-label="Chat message"
              data-testid="input-chat-message"
              rows={1}
            />
            {streaming ? (
              <button className="composer-send stop" onClick={stop} data-testid="button-stop">
                <Square size={14} /> Stop
              </button>
            ) : (
              <button className="composer-send" onClick={send} disabled={!input.trim()} data-testid="button-send">
                <Send size={14} /> Send
              </button>
            )}
          </div>
          <div className="composer-actions">
            <div className="composer-model-selector">
              <select
                className="select"
                value={selectedProvider}
                onChange={e => setSelectedProvider(e.target.value)}
                aria-label="Provider"
                style={{ minHeight: 32, fontSize: 12 }}
                data-testid="select-provider"
              >
                <option value="">— Provider —</option>
                {enabledProviders.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <input
                className="input"
                placeholder="model id"
                value={selectedModel}
                onChange={e => setSelectedModel(e.target.value)}
                aria-label="Model"
                style={{ minHeight: 32, fontSize: 12, maxWidth: 220, minWidth: 120 }}
                data-testid="input-model"
              />
            </div>
            <div className="composer-meta">
              <span>Enter to send · Shift+Enter for newline</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

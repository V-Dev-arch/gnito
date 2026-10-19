import React, { useEffect, useRef, useState } from 'react';
import { EyeOff, LogOut, Send, ShieldAlert, Square } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ModelInfo } from '../../../shared/types.js';
import { api } from '../../lib/api.js';

interface Provider { id: string; label: string; enabled: boolean }
interface IncMessage { id: string; role: 'user' | 'assistant'; content: string; createdAt: number }

export function IncognitoPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelId, setModelId] = useState('');
  const [manualModel, setManualModel] = useState('');
  const [messages, setMessages] = useState<IncMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState('');
  const [activity, setActivity] = useState('');
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const selectedModel = modelId || manualModel.trim();
  const usableProviders = providers.filter(p => p.enabled);

  const start = async () => {
    try {
      const r = await api.post('/api/incognito/start');
      sessionIdRef.current = r.sessionId;
      setSessionId(r.sessionId);
      setMessages([]);
      setError(null);
    } catch (e: any) { setError(`Could not start a temporary session: ${e.message}`); }
  };

  useEffect(() => {
    let alive = true;
    api.post('/api/incognito/start').then((r: any) => {
      if (alive) { sessionIdRef.current = r.sessionId; setSessionId(r.sessionId); }
      else api.post(`/api/incognito/${r.sessionId}/exit`).catch(() => {});
    }).catch((e: Error) => { if (alive) setError(`Could not start a temporary session: ${e.message}`); });
    api.get('/api/providers').then((ps: Provider[]) => {
      if (!alive) return;
      const enabled = ps.filter(p => p.enabled);
      setProviders(ps);
      if (enabled.length) setProviderId(enabled[0].id);
    }).catch((e: Error) => { if (alive) setError(`Could not load providers: ${e.message}`); });
    return () => {
      alive = false;
      abortRef.current?.abort();
      const sid = sessionIdRef.current;
      if (sid) api.post(`/api/incognito/${sid}/exit`).catch(() => {});
    };
  }, []);

  useEffect(() => {
    let alive = true;
    if (!providerId) { setModels([]); return; }
    setModels([]);
    setModelId('');
    api.get(`/api/providers/${providerId}/models`).then((r: { models: ModelInfo[] }) => {
      if (alive) { setModels(r.models || []); setModelId(r.models?.[0]?.id || ''); }
    }).catch((e: Error) => { if (alive) setError(`Model discovery failed: ${e.message}`); });
    return () => { alive = false; };
  }, [providerId]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streamedText]);

  const send = async () => {
    const content = input.trim();
    if (!content || !sessionId || streaming) return;
    if (!providerId) { setError('Add or enable a provider in Settings before sending.'); return; }
    if (!selectedModel) { setError('Select a model before sending. If discovery is unavailable, enter its model ID.'); return; }
    setError(null);
    setInput('');
    setStreaming(true);
    setStreamedText('');
    setActivity(`Saving in this temporary session…`);
    const userMessage: IncMessage = { id: `u-${Date.now()}`, role: 'user', content, createdAt: Date.now() };
    try {
      await api.post(`/api/incognito/${sessionId}/message`, { role: 'user', content });
    } catch (e: any) {
      setStreaming(false); setActivity(''); setInput(content); setError(`Could not save this message in temporary memory. ${e.message}`); return;
    }
    setMessages(current => [...current, userMessage]);
    setActivity(`Connecting to ${providers.find(p => p.id === providerId)?.label || 'provider'} · ${selectedModel}…`);
    const prior = messages.map(m => ({ role: m.role, content: m.content }));
    abortRef.current = api.streamChat(providerId, { model: selectedModel, messages: [...prior, { role: 'user', content }], stream: true },
      delta => { setActivity(`Generating with ${selectedModel}`); setStreamedText(text => text + delta); },
      finalText => {
        setStreaming(false); setActivity(''); setStreamedText('');
        if (!finalText) { setError('The provider ended without returning text. Check the model or provider response.'); return; }
        const assistantMessage: IncMessage = { id: `a-${Date.now()}`, role: 'assistant', content: finalText, createdAt: Date.now() };
        setMessages(current => [...current, assistantMessage]);
        api.post(`/api/incognito/${sessionId}/message`, { role: 'assistant', content: finalText })
          .catch((e: Error) => setError(`Response arrived but could not be kept in temporary memory. ${e.message}`));
      },
      message => { setStreaming(false); setActivity(''); setError(message); },
      true,
    );
  };

  const stop = () => {
    abortRef.current?.abort();
    setStreaming(false);
    setActivity('Generation stopped by you.');
    if (streamedText && sessionId) {
      const content = `${streamedText}\n\n_[Generation stopped]_`;
      const message: IncMessage = { id: `a-${Date.now()}`, role: 'assistant', content, createdAt: Date.now() };
      setMessages(current => [...current, message]);
      api.post(`/api/incognito/${sessionId}/message`, { role: 'assistant', content }).catch((e: Error) => setError(e.message));
    }
    setStreamedText('');
  };

  const exit = async () => {
    abortRef.current?.abort();
    if (sessionId) await api.post(`/api/incognito/${sessionId}/exit`).catch(() => {});
    sessionIdRef.current = null;
    setSessionId(null); setMessages([]); setStreamedText(''); setActivity(''); setStreaming(false);
  };

  return (
    <div className="chat-page">
      <div className="chat-container">
        <div className="chat-header">
          <div><h1 className="chat-title"><EyeOff size={20} style={{ display: 'inline', marginRight: 8, verticalAlign: 'text-bottom' }} />Incognito Chat</h1><div className="chat-header-caption"><span>Temporary session · nothing is saved to chat history</span></div></div>
          {sessionId && <button className="btn btn-secondary btn-sm" onClick={exit} data-testid="button-exit-incognito"><LogOut size={14} /> Exit session</button>}
        </div>
        <div className="automation-warning" role="status"><ShieldAlert size={16} /><span>Incognito Mode prevents local history and memory persistence. It does <strong>not</strong> make you anonymous to external services. Your selected model provider may process messages you send.</span></div>
        {!sessionId && <div className="card incognito-restart"><div className="card-title">Temporary session ended</div><div className="card-description">Its messages were discarded. Start a new in-memory session whenever you are ready.</div><button className="btn btn-primary" onClick={start}>Start a new session</button></div>}
        {messages.length === 0 && sessionId && <div className="empty-state"><EyeOff size={40} style={{ color: 'var(--color-warning)', margin: '0 auto 16px' }} /><div className="empty-state-title">A private local session</div><div className="empty-state-text">Messages stay in temporary memory until you exit, after 30 minutes of inactivity, or at the 12-hour maximum. Provider calls still go to the service you select.</div></div>}
        <div className="chat-messages">
          {messages.map(m => <div key={m.id} className={`message ${m.role}`} data-testid={`inc-message-${m.id}`}><div className="message-role">{m.role === 'user' ? 'You' : 'Gnito'}</div><div className="message-content markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div></div>)}
          {streaming && <div className="message assistant"><div className="message-role">Gnito <span className="message-model">{activity}</span></div><div className="message-content markdown">{streamedText ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamedText}</ReactMarkdown> : <div className="streaming-indicator"><div className="dots"><span className="dot" /><span className="dot" /><span className="dot" /></div><span>{activity || 'Waiting for provider response…'}</span></div>}</div></div>}
          {error && <div className="request-error" role="alert"><div><strong>Incognito request failed</strong><p>{error}</p></div><button className="btn btn-ghost btn-sm" onClick={() => setError(null)}>Dismiss</button></div>}
          <div ref={endRef} />
        </div>
      </div>
      {sessionId && <div className="composer"><div className="composer-inner">
        <div className="composer-input-row"><textarea className="composer-textarea" placeholder="Message in Incognito…" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} aria-label="Incognito message" data-testid="input-incognito-message" rows={1} />
          {streaming ? <button className="composer-send stop" onClick={stop} data-testid="button-incognito-stop"><Square size={14} /> Stop</button> : <button className="composer-send" onClick={send} disabled={!input.trim()} data-testid="button-incognito-send"><Send size={14} /> Send</button>}
        </div>
        <div className="composer-actions"><div className="composer-model-selector"><select className="select" value={providerId} onChange={e => setProviderId(e.target.value)} aria-label="Incognito provider">{usableProviders.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
          {models.length > 0 ? <select className="select" value={modelId} onChange={e => setModelId(e.target.value)} aria-label="Incognito model">{models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select> : <input className="input model-fallback" value={manualModel} onChange={e => setManualModel(e.target.value)} placeholder="Model ID" aria-label="Incognito model ID" />}</div>
          <div className="composer-meta"><span>Temporary memory only · Shift+Enter for a new line</span></div></div>
      </div></div>}
    </div>
  );
}

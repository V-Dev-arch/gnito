import type { ProviderKind } from './types.js';

export interface ProviderPreset {
  id: string;
  label: string;
  kind: Exclude<ProviderKind, 'custom'>;
  baseUrl: string;
  color: string;
  logo: string;
}

/** Official API roots for vendors with OpenAI-compatible or native Anthropic APIs. */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', color: '#10a37f', logo: 'openai' },
  { id: 'anthropic', label: 'Anthropic', kind: 'anthropic-compatible', baseUrl: 'https://api.anthropic.com', color: '#d97757', logo: 'anthropic' },
  { id: 'google', label: 'Google Gemini', kind: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', color: '#4285f4', logo: 'gemini' },
  { id: 'groq', label: 'Groq', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', color: '#f55036', logo: 'groq' },
  { id: 'xai', label: 'xAI (Grok)', kind: 'openai-compatible', baseUrl: 'https://api.x.ai/v1', color: '#111827', logo: 'xai' },
  { id: 'moonshot', label: 'Moonshot (Kimi)', kind: 'openai-compatible', baseUrl: 'https://api.moonshot.ai/v1', color: '#5c55d6', logo: 'moonshot' },
  { id: 'zai', label: 'Z.ai', kind: 'openai-compatible', baseUrl: 'https://api.z.ai/api/paas/v4', color: '#4777f5', logo: 'zai' },
];

export const CUSTOM_PROVIDER_PRESET: ProviderPreset = {
  id: 'custom', label: 'Custom OpenAI-compatible', kind: 'openai-compatible', baseUrl: '', color: '#7b7f8c', logo: 'custom',
};

// Manus exposes an asynchronous Responses/Tasks API rather than the synchronous
// chat-completions protocol supported by this adapter. Do not register it as a
// working chat preset until that protocol has its own adapter.
export const MANUS_PROVIDER_NOTICE = 'Manus API uses an asynchronous Responses/Tasks protocol and is not compatible with this chat-completions adapter yet.';

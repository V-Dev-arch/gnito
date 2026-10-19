import type { ProviderKind } from './types.js';

export interface ProviderPreset {
  id: string;
  label: string;
  kind: Exclude<ProviderKind, 'custom'>;
  baseUrl: string;
  color: string;
  logo: string;
}

/** Official provider roots; Manus uses its own asynchronous Tasks API adapter. */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', color: '#10a37f', logo: 'openai' },
  { id: 'anthropic', label: 'Anthropic', kind: 'anthropic-compatible', baseUrl: 'https://api.anthropic.com', color: '#d97757', logo: 'anthropic' },
  { id: 'google', label: 'Google Gemini', kind: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', color: '#4285f4', logo: 'gemini' },
  { id: 'groq', label: 'Groq', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', color: '#f55036', logo: 'groq' },
  { id: 'xai', label: 'SpaceXAI (Grok)', kind: 'openai-compatible', baseUrl: 'https://api.x.ai/v1', color: '#111827', logo: 'xai' },
  { id: 'manus', label: 'Manus', kind: 'manus-agent', baseUrl: 'https://api.manus.ai', color: '#34322d', logo: 'manus' },
  { id: 'moonshot', label: 'Moonshot (Kimi)', kind: 'openai-compatible', baseUrl: 'https://api.moonshot.ai/v1', color: '#5c55d6', logo: 'moonshot' },
  { id: 'zai', label: 'Z.ai', kind: 'openai-compatible', baseUrl: 'https://api.z.ai/api/paas/v4', color: '#4777f5', logo: 'zai' },
];

export const CUSTOM_PROVIDER_PRESET: ProviderPreset = {
  id: 'custom', label: 'Custom OpenAI-compatible', kind: 'openai-compatible', baseUrl: '', color: '#7b7f8c', logo: 'custom',
};

export const MANUS_PROVIDER_NOTICE = 'Manus runs as a remote asynchronous task. It does not run commands in Gnito’s local Docker workspace or use Gnito MCP connectors.';

import { describe, expect, it } from 'vitest';
import { supportsImageTools } from '../../src/client/features/chat/providerCapabilities.js';

describe('Image tools provider capability', () => {
  it('allows OpenAI-compatible presets regardless of their URL or preset label', () => {
    for (const baseUrl of [
      'https://api.openai.com/v1',
      'https://generativelanguage.googleapis.com/v1beta/openai',
      'https://api.groq.com/openai/v1',
      'https://api.x.ai/v1',
      'https://api.moonshot.ai/v1',
      'https://api.z.ai/api/paas/v4',
    ]) {
      const provider = { kind: 'openai-compatible', baseUrl };
      expect(supportsImageTools(provider)).toBe(true);
    }
  });

  it('allows custom-compatible endpoints and rejects unsupported provider kinds', () => {
    expect(supportsImageTools({ kind: 'custom' })).toBe(true);
    expect(supportsImageTools({ kind: 'anthropic-compatible' })).toBe(false);
    expect(supportsImageTools({ kind: 'manus-agent' })).toBe(false);
    expect(supportsImageTools()).toBe(false);
  });
});

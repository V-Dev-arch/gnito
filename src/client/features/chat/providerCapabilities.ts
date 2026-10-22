export interface ImageToolProvider {
  kind: string;
}

/** Image tools use the OpenAI-compatible Images API adapter, not provider URL heuristics. */
export function supportsImageTools(provider?: ImageToolProvider): boolean {
  return provider?.kind === 'custom' || provider?.kind === 'openai-compatible';
}

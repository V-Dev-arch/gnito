export interface ImageToolProvider {
  kind: string;
}

/** Image tools are local AI-authored SVG creation, so they do not require an Images API. */
export function supportsImageTools(provider?: ImageToolProvider): boolean {
  return Boolean(provider && provider.kind !== 'manus-agent');
}

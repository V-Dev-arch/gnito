import React from 'react';
import type { ProviderPreset } from '../../shared/providerPresets';

const SVG_ASSETS: Record<string, string> = {
  openai: '/brand/providers/openai.svg',
  anthropic: '/brand/providers/anthropic.svg',
  gemini: '/brand/providers/gemini.svg',
  groq: '/brand/providers/groq.svg',
  manus: '/brand/providers/manus.svg',
  moonshot: '/brand/providers/moonshot.svg',
  xai: '/brand/providers/spacexai.svg',
  zai: '/brand/providers/zai.svg',
};

export function ProviderLogo({ preset, size = 20 }: { preset: ProviderPreset; size?: number }) {
  const asset = SVG_ASSETS[preset.logo];
  if (asset) {
    const width = preset.logo === 'xai' || preset.logo === 'groq' ? size * 2.6 : size;
    return <img className={`provider-logo provider-logo-img provider-logo-${preset.logo}`} src={asset} alt={`${preset.label} logo`} width={width} height={size} />;
  }
  // Generic neutral fallback for custom or unrecognized provider marks.
  const initials = preset.logo === 'xai' ? 'X' : preset.logo === 'zai' ? 'Z' : preset.logo.slice(0, 2).toUpperCase();
  return (
    <svg
      className={`provider-logo provider-logo-fallback ${preset.logo}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={`${preset.label} mark`}
    >
      <rect x="1" y="1" width="22" height="22" rx="7" fill={preset.color} />
      <text x="12" y="16" textAnchor="middle" fill="white" fontSize="11" fontWeight="700" fontFamily="system-ui, sans-serif">{initials}</text>
    </svg>
  );
}

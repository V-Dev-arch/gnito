import React from 'react';
import { siAnthropic, siGooglegemini, siMoonshotai } from 'simple-icons';
import type { ProviderPreset } from '../../shared/providerPresets';

const ICONS: Record<string, { path: string; hex: string } | undefined> = {
  anthropic: siAnthropic,
  gemini: siGooglegemini,
  moonshot: siMoonshotai,
};

export function ProviderLogo({ preset, size = 20 }: { preset: ProviderPreset; size?: number }) {
  if (preset.logo === 'openai') {
    return <img className="provider-logo provider-logo-img" src="/brand/providers/openai.svg" alt="OpenAI logo" width={size} height={size} />;
  }
  const icon = ICONS[preset.logo];
  if (icon) {
    return (
      <svg
        className="provider-logo"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        role="img"
        aria-label={`${preset.label} logo`}
        style={{ color: `#${icon.hex}` }}
      >
        <path d={icon.path} fill="currentColor" transform="scale(0.75) translate(4 4)" />
      </svg>
    );
  }
  const initials = preset.logo === 'openai' ? '◎' : preset.logo.slice(0, 2).toUpperCase();
  return (
    <svg
      className={`provider-logo provider-logo-fallback ${preset.logo}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={`${preset.label} icon`}
    >
      <rect x="1" y="1" width="22" height="22" rx="7" fill={preset.color} />
      <text x="12" y="16" textAnchor="middle" fill="white" fontSize="10" fontWeight="700" fontFamily="system-ui, sans-serif">{initials}</text>
    </svg>
  );
}

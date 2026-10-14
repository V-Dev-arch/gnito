# Gnito — Design System

## Tokens

All colors, spacing, radii, type scale, and motion live in
`src/client/styles/tokens.css`. Components reference CSS variables —
no raw hex values in component code.

### Color roles

| Role | Dark | Light |
|---|---|---|
| `--color-bg` | `#16161A` | `#F7F7F5` |
| `--color-surface` | `#1C1C22` | `#FFFFFF` |
| `--color-border` | `#35353E` | `#E4E4E0` |
| `--color-text` | `#F0F0ED` | `#1A1A18` |
| `--color-primary` | `#8B7FF2` | `#5B4FE0` |
| `--color-success` | `#3FA670` | `#1E7A46` |
| `--color-warning` | `#E5A34D` | `#B26504` |
| `--color-error` | `#F06666` | `#C02626` |

Dark is the default theme; light is a deliberate re-derivation (not an
inversion). Both are set via `[data-theme]` attribute on `<html>`, with
`prefers-color-scheme` as fallback when no explicit theme is set.

### Spacing

4px base: `--space-1` … `--space-20`. Every margin, padding, gap uses
a token.

### Type scale

Fluid via `clamp()`: `--text-xs` (12–14px) … `--text-xl` (24–36px).
Web-app pages cap at `--text-xl`; no display-scale type.

### Radii / motion

`--radius-xs` … `--radius-full`; `--transition-interactive: 180ms
cubic-bezier(0.16, 1, 0.3, 1)`.

## Brand

- `public/brand/logo.svg` — full mark with gradient.
- `public/brand/logo-mono.svg` — monochrome sidebar mark (`currentColor`).
- `public/brand/favicon.svg` — 32px favicon.
- `public/brand/wordmark.svg` — horizontal lockup.

The mark is a stylized "G": an orbit (intelligence) around a core
(the machine) with a slash through (your rules).

## Accessibility

- Semantic HTML throughout (`<aside>`, `<main>`, `<nav>`).
- `aria-label` on icon-only buttons.
- `:focus-visible` outline using `--color-primary`.
- `prefers-reduced-motion` respected globally (base.css).
- 44px minimum touch targets on interactive elements.
- Skip-to-content link as first focusable element.

## Adding a new screen

1. Create `src/client/features/<name>/<Name>Page.tsx`.
2. Add a route in `src/client/App.tsx` inside the `Switch`.
3. Add a nav entry in `src/client/ui/AppShell.tsx` `NAV` array.
4. Add palette commands in `src/client/ui/CommandPalette.tsx`.
5. Reference tokens — never raw hex/px.

import { THEME_PRESET_PALETTES } from '@hermes/shared/theme-presets'

export const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

export const INTRO_PALETTE = THEME_PRESET_PALETTES.cupertino.darkColors
export const ACCENT = INTRO_PALETTE.primary
export const ACCENT_DIM = `color-mix(in srgb, ${ACCENT} 65%, transparent)`

// One shadow for every floating surface. It follows --shadow-nous (single top
// light, layered contact to ambient, x = 0, negative spread on each layer) at
// lower opacity for the dark background, so cards do not cast black halos over
// the frost.
export const NOUS_SHADOW =
  '0 2px 4px -2px rgba(0,0,0,0.3), 0 8px 12px -6px rgba(0,0,0,0.24), 0 20px 28px -14px rgba(0,0,0,0.2), 0 36px 48px -28px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.05)'

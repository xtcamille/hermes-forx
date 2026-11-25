import { getCurrentWindow, type Theme } from '@tauri-apps/api/window'

import { desktopColorSeeds, THEME_PRESET_PALETTES } from '../../shared/src/theme-presets'

/*
 * OS appearance follower.
 *
 * The installer ships no in-app theme switcher, so it tracks the system the
 * way the desktop overlays do. Two Tauri realities shape this:
 *
 *   1. The strict `script-src 'self'` CSP (tauri.conf.json) forbids an inline
 *      pre-paint <script> in index.html, so the earliest hook we get is this
 *      bundled module.
 *   2. The webview's `prefers-color-scheme` is not reliable across WebView2 /
 *      WebKitGTK. The authoritative signal in a Tauri window is the window's
 *      OWN theme — `getCurrentWindow().theme()` + `onThemeChanged` — so we read
 *      that and fall back to the media query only outside Tauri (e.g. plain
 *      `vite preview`).
 *
 * Paint the default desktop palette into the shared stylesheet for that appearance.
 */

const prefersDark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches

function paint(theme: Theme): void {
  const dark = theme === 'dark'
  const { colors, darkColors } = THEME_PRESET_PALETTES.cupertino
  const palette = dark ? darkColors : colors
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  root.style.colorScheme = dark ? 'dark' : 'light'

  const properties = {
    ...desktopColorSeeds(palette),
    '--dt-primary-foreground': palette.primaryForeground,
    '--dt-primary-solid-foreground': palette.primaryForeground,
    '--dt-ring': palette.ring,
    '--dt-border': palette.border,
    '--dt-destructive': palette.destructive,
    '--dt-destructive-foreground': palette.destructiveForeground
  }

  for (const [name, value] of Object.entries(properties)) {
    root.style.setProperty(name, value)
  }
}

// Best-effort synchronous first paint from the media query so the very first
// frame is already in the right mode. Refined below by the authoritative Tauri
// window theme once its IPC resolves.
paint(prefersDark() ? 'dark' : 'light')

/** Adopt the Tauri window theme and keep tracking live OS appearance changes. */
export async function watchTheme(): Promise<void> {
  try {
    const win = getCurrentWindow()
    const current = await win.theme()

    if (current) {
      paint(current)
    }

    await win.onThemeChanged(({ payload }) => paint(payload))
  } catch {
    // Non-Tauri context (e.g. `vite preview`): keep the media query live.
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', e => paint(e.matches ? 'dark' : 'light'))
  }
}

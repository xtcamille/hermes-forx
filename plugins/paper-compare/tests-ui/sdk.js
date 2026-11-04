import { atom } from 'nanostores'
import { createElement, useSyncExternalStore } from 'react'
import { vi } from 'vitest'
export const useValue = store => useSyncExternalStore(callback => store.listen(callback), () => store.get())
export const theme = atom({ theme: { colors: { background: '#fafafa', foreground: '#111111', card: '#ffffff', primary: '#245edb' } }, renderedMode: 'light' })
export const useTheme = () => useValue(theme)
export const host = { state: { connectionId: atom('local'), profile: atom('default'), gateway: atom('open') },
  connections: vi.fn(async () => [{ id: 'local', kind: 'local', primary: true }]), activeConnectionId: () => 'local', navigate: vi.fn() }
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar'
export const PALETTE_AREA = 'palette'
export const Button = ({ variant, size, ...props }) => createElement('button', props)
export const GlyphSpinner = () => createElement('span', { 'aria-label': '处理中' })

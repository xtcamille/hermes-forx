import { atom } from 'nanostores'
import { createElement, useSyncExternalStore } from 'react'
export { atom } from 'nanostores'
export { useQuery, useQueryClient, QueryClient, QueryClientProvider } from '@tanstack/react-query'
export const useValue = store => useSyncExternalStore(callback => store.listen(callback), () => store.get())
export const host = { state: { connectionId: atom('local'), profile: atom('default'), gateway: atom('open') }, navigate() {} }
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar'
export const PALETTE_AREA = 'palette'
export const Button = ({ variant, size, ...props }) => createElement('button', props)
export const Input = props => createElement('input', props)
export const Textarea = props => createElement('textarea', props)
export const GlyphSpinner = () => createElement('span', { 'aria-label': '处理中' })

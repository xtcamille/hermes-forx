import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import plugin from '../desktop/plugin.js'
import { host, theme } from './sdk.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root, container
const url = name => `http://127.0.0.1:43210/workbench/${name}/`
async function render(rest) {
  container = document.createElement('div'); document.body.append(container)
  const ctx = { registerMany: vi.fn(), rest }
  plugin.register(ctx)
  root = createRoot(container)
  const route = ctx.registerMany.mock.calls[0][0].find(row => row.area === 'routes')
  await act(async () => { root.render(route.render()); await Promise.resolve() })
  return ctx
}
beforeEach(() => {
  host.state.connectionId.set('local'); host.state.profile.set('default'); host.state.gateway.set('open')
  host.connections.mockReset().mockResolvedValue([{ id: 'local', kind: 'local', primary: true }])
  host.navigate.mockReset()
})
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); root = null })

test('connection and profile swaps discard old frames and late launch replies; remote mode never launches loopback', async () => {
  let finishFirst
  const rest = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
    .mockResolvedValueOnce({ url: url('profile-b') }).mockResolvedValueOnce({ url: url('reconnected') })
  await render(rest)
  await act(async () => host.state.profile.set('reader-b'))
  expect(container.querySelector('iframe')?.src).toBe(url('profile-b'))
  await act(async () => finishFirst({ url: url('old-profile-a') }))
  expect(container.querySelector('iframe')?.src).toBe(url('profile-b'))
  await act(async () => host.state.gateway.set('closed'))
  expect(container.querySelector('iframe')).toBeNull()
  await act(async () => host.state.gateway.set('open'))
  expect(container.querySelector('iframe')?.src).toBe(url('reconnected'))
  host.connections.mockResolvedValue([{ id: 'remote-a', kind: 'ssh' }])
  await act(async () => host.state.connectionId.set('remote-a'))
  expect(container.querySelector('iframe')).toBeNull()
  expect(container.textContent).toContain('远程与云端连接不会载入本机论文')
  expect(rest).toHaveBeenCalledTimes(3)
})

test('only the current frame can open settings; live themes are sent without recreating the workbench', async () => {
  const rest = vi.fn().mockResolvedValue({ url: url('current') })
  await render(rest)
  const frame = container.querySelector('iframe')
  const send = vi.spyOn(frame.contentWindow, 'postMessage')
  await act(async () => theme.set({ theme: { colors: { background: '#161616', foreground: '#eeeeee' } }, renderedMode: 'dark' }))
  expect(container.querySelector('iframe')).toBe(frame)
  expect(rest).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'paper-compare:appearance', mode: 'dark' }), 'http://127.0.0.1:43210')
  const message = (source, origin) => window.dispatchEvent(new MessageEvent('message', { source, origin, data: { type: 'paper-compare:open-provider-settings' } }))
  await act(async () => { message(window, 'http://127.0.0.1:43210'); message(frame.contentWindow, 'https://untrusted.example') })
  expect(host.navigate).not.toHaveBeenCalled()
  await act(async () => message(frame.contentWindow, 'http://127.0.0.1:43210'))
  expect(host.navigate).toHaveBeenCalledWith('/settings?tab=providers')
  await act(async () => host.state.gateway.set('closed'))
  await act(async () => message(frame.contentWindow, 'http://127.0.0.1:43210'))
  expect(host.navigate).toHaveBeenCalledTimes(1)
})

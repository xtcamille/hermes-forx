import { host, useValue, ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA, Button, GlyphSpinner } from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

function PaperPage({ ctx }) {
  const profile = useValue(host.state.profile)
  const gateway = useValue(host.state.gateway)
  const [session, setSession] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const frame = useRef(null)
  useEffect(() => {
    const openSettings = event => {
      if (!session || session.owner !== profile || event.source !== frame.current?.contentWindow
        || event.origin !== new URL(session.url).origin || event.data?.type !== 'paper-compare:open-provider-settings') return
      host.navigate('/settings?tab=providers')
    }
    window.addEventListener('message', openSettings)
    return () => window.removeEventListener('message', openSettings)
  }, [session, profile])
  useEffect(() => {
    if (gateway !== 'open') return
    let current = true
    setError('')
    ctx.rest('/launch', { method: 'POST', body: { frameOrigin: window.location.origin }, timeoutMs: 40000 })
      .then(value => { if (current) setSession({ ...value, owner: profile }) })
      .catch(reason => {
        if (!current) return
        const message = reason.message || ''
        setError(/404|ECONNRESET|ECONNREFUSED|Failed to fetch/.test(message)
          ? '尚未连接到论文插件后端。如果刚安装插件，请重新启动 ForX 后再连接；已有论文和阅读记录会保留。'
          : message || '论文插件后端未就绪。请启用 Python 插件并重新启动后端。')
      })
    return () => { current = false }
  }, [ctx, profile, gateway, attempt])
  const ready = session?.owner === profile && !error
  return jsxs('section', {
    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
    'aria-label': '论文工作台',
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 38, padding: '0 16px', borderBottom: '1px solid var(--ui-stroke-secondary)', color: 'var(--ui-text-secondary)', fontSize: 12 },
        children: [jsx('span', { children: '论文工作台 · ForX 账号与模型 · 本机保存' }), ready
          ? jsx(Button, { variant: 'text', size: 'sm', onClick: () => setAttempt(value => value + 1), children: '重新连接' })
          : jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: '多模型阅读 / 图表精读 / 证据核验' })]
      }),
      ready ? jsx('iframe', {
        key: session.url, ref: frame, title: '论文对照台', src: session.url,
        sandbox: 'allow-scripts allow-same-origin allow-downloads allow-forms allow-modals',
        referrerPolicy: 'no-referrer',
        style: { flex: 1, width: '100%', border: 0, minHeight: 0 },
      }) : jsxs('div', {
        role: error ? 'alert' : 'status',
        style: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32, color: 'var(--ui-text-secondary)' },
        children: [
          !error && jsx(GlyphSpinner, {}),
          jsx('p', { style: { maxWidth: 520, lineHeight: 1.7, textAlign: 'center' }, children: error || '正在连接本机论文库…' }),
          error && jsx(Button, { variant: 'secondary', onClick: () => { setSession(null); setAttempt(value => value + 1) }, children: '重新连接' }),
        ],
      }),
    ],
  })
}

export default {
  id: 'paper-compare',
  name: '论文工作台',
  defaultEnabled: false,
  register(ctx) {
    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: '/papers' }, render: () => jsx(PaperPage, { ctx }) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: '/papers', label: '论文工作台', codicon: 'book' } },
      { id: 'open', area: PALETTE_AREA, data: { id: 'paper-compare.open', label: '打开论文工作台', keywords: ['paper', '论文', '证据'], run: () => host.navigate('/papers') } },
    ])
  },
}

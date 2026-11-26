import { host, useValue, useTheme, ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA, Button, GlyphSpinner } from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

function PaperPage({ ctx }) {
  const profile = useValue(host.state.profile)
  const connectionId = useValue(host.state.connectionId)
  const gateway = useValue(host.state.gateway)
  const { theme, renderedMode } = useTheme()
  const owner = JSON.stringify([connectionId, profile])
  const [session, setSession] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const frame = useRef(null)
  const ready = gateway === 'open' && session?.owner === owner && !error
  const stillOwned = () => host.state.profile.get() === profile
    && host.state.connectionId.get() === connectionId && host.state.gateway.get() === 'open'
  const appearance = () => {
    if (ready && stillOwned()) frame.current?.contentWindow?.postMessage({
      type: 'paper-compare:appearance', mode: renderedMode, colors: theme.colors,
    }, new URL(session.url).origin)
  }

  useEffect(() => {
    const receive = event => {
      if (!ready || !stillOwned() || event.source !== frame.current?.contentWindow
        || event.origin !== new URL(session.url).origin) return
      if (event.data?.type === 'paper-compare:open-provider-settings') host.navigate('/settings?tab=providers')
      if (event.data?.type === 'paper-compare:ready') appearance()
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [ready, session, owner, theme, renderedMode])

  useEffect(() => { appearance() }, [ready, session, theme, renderedMode])

  useEffect(() => {
    let current = true
    setSession(null)
    setError('')
    if (gateway !== 'open') return
    async function connect() {
      // A loopback URL on a remote host points at the wrong computer. Resolve
      // the owning connection before launching any service or showing old data.
      const connections = await host.connections()
      if (!current || !stillOwned()) return
      const id = connectionId || host.activeConnectionId()
      const connection = connections.find(row => row.id === id) || (!id && connections.find(row => row.primary))
      if (connection?.kind !== 'local') throw new Error('论文工作台需要本机 ForX 连接。请切换到本机配置档案后打开；远程与云端连接不会载入本机论文。')
      const value = await ctx.rest('/launch', { method: 'POST', body: { frameOrigin: window.location.origin }, timeoutMs: 240000 })
      if (!current || !stillOwned()) return
      const url = new URL(value.url)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
        || url.search || url.hash || !url.pathname.startsWith('/workbench/') || !url.pathname.endsWith('/')) {
        throw new Error('论文插件未返回有效的本机工作台地址，请重新连接。')
      }
      setSession({ url: url.href, owner })
    }
    connect().catch(reason => {
      if (!current || !stillOwned()) return
      const message = reason.message || ''
      setError(/404|ECONNRESET|ECONNREFUSED|Failed to fetch/.test(message)
        ? '论文插件后端尚未启用。请在 Capabilities → Plugins 启用论文工作台的后端，并重新启动 ForX 后端。已有阅读记录会保留。'
        : message || '论文插件后端未就绪。请检查插件运行环境后重试。')
    })
    return () => { current = false }
  }, [ctx, profile, connectionId, gateway, attempt])

  return jsxs('section', {
    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--ui-bg-base)' },
    'aria-label': '论文工作台',
    children: [
      jsx('div', {
        style: { display: 'flex', alignItems: 'center', minHeight: 36, padding: '0 16px', borderBottom: '1px solid var(--ui-stroke-secondary)', color: 'var(--ui-text-secondary)', fontSize: 12 },
        children: `论文工作台 · ${profile || 'default'} · 本机保存`,
      }),
      ready ? jsx('iframe', {
        key: session.url, ref: frame, title: '论文对照台', src: session.url, onLoad: appearance,
        sandbox: 'allow-scripts allow-same-origin allow-downloads allow-forms allow-modals',
        referrerPolicy: 'no-referrer',
        style: { flex: 1, width: '100%', border: 0, minHeight: 0 },
      }) : jsxs('div', {
        role: error ? 'alert' : 'status',
        style: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32, color: 'var(--ui-text-secondary)' },
        children: [
          !error && gateway === 'open' && jsx(GlyphSpinner, {}),
          jsx('p', { style: { maxWidth: 540, lineHeight: 1.7, textAlign: 'center' }, children: error
            || (gateway === 'open' ? '正在准备本机论文工作台，首次使用会校验运行环境…' : '等待 ForX 连接。本机已保存的论文和生成记录会保留。') }),
          error && jsx(Button, { variant: 'secondary', onClick: () => setAttempt(value => value + 1), children: '重新连接' }),
        ],
      }),
    ],
  })
}

export default {
  id: 'paper-compare', name: '论文工作台', defaultEnabled: false,
  register(ctx) {
    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: '/papers' }, render: () => jsx(PaperPage, { ctx }) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: '/papers', label: '论文工作台', codicon: 'book' } },
      { id: 'open', area: PALETTE_AREA, data: { id: 'paper-compare.open', label: '打开论文工作台', keywords: ['paper', '论文', '证据'], run: () => host.navigate('/papers') } },
    ])
  },
}

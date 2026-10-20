(() => {
  const SDK = window.__HERMES_PLUGIN_SDK__
  const R = SDK.React
  function PaperPage() {
    const [url, setUrl] = R.useState('')
    const [error, setError] = R.useState('')
    const [attempt, setAttempt] = R.useState(0)
    const frame = R.useRef(null)
    R.useEffect(() => {
      const openSettings = event => {
        if (!url || event.source !== frame.current?.contentWindow || event.origin !== new URL(url).origin
          || event.data?.type !== 'paper-compare:open-provider-settings') return
        location.assign(location.pathname.replace(/\/papers\/?$/, '/config'))
      }
      window.addEventListener('message', openSettings)
      return () => window.removeEventListener('message', openSettings)
    }, [url])
    R.useEffect(() => {
      let active = true
      setError('')
      SDK.fetchJSON('/api/plugins/paper-compare/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frameOrigin: location.origin }) })
        .then(value => { if (active) setUrl(value.url) })
        .catch(reason => { if (active) setError(reason.message) })
      return () => { active = false }
    }, [attempt])
    return R.createElement('section', { style: { height: 'calc(100vh - 130px)', minHeight: 600, display: 'flex', flexDirection: 'column' }, 'aria-label': '论文工作台' },
      url && !error ? R.createElement('iframe', { ref: frame, src: url, title: '论文对照台', referrerPolicy: 'no-referrer', sandbox: 'allow-scripts allow-same-origin allow-downloads allow-forms allow-modals', style: { flex: 1, width: '100%', border: 0 } })
        : R.createElement('div', { role: error ? 'alert' : 'status', style: { padding: 40, textAlign: 'center' } },
          R.createElement('p', null, error || '正在连接本机论文库…'),
          error && R.createElement('button', { onClick: () => setAttempt(x => x + 1) }, '重新连接')))
  }
  window.__HERMES_PLUGINS__.register('paper-compare', PaperPage)
})()

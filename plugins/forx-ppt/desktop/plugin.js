import { atom, host, useValue, useQuery, useQueryClient, ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA, Button, Input, Textarea, GlyphSpinner } from '@hermes/plugin-sdk'
import { createElement as h, useEffect, useRef, useState } from 'react'

const flex = { display: 'flex', alignItems: 'center', gap: 8 }
const button = (label, onClick, disabled = false, extra = {}) => h(Button, { size: 'sm', variant: 'secondary', onClick: () => void onClick(), disabled, ...extra }, label)
const uid = () => crypto.randomUUID()
const ownerKey = () => JSON.stringify([host.state.connectionId.get(), host.state.profile.get()])
const flatten = elements => elements.flatMap(e => [e, ...flatten(e.children || [])])
const fileData = file => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result).split(',')[1])
  reader.onerror = () => reject(new Error('文件无法读取'))
  reader.readAsDataURL(file)
})

const Icon = {
  ppt: () => h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
    h('rect', { x: 2, y: 3, width: 20, height: 14, rx: 2 }),
    h('line', { x1: 8, y1: 21, x2: 16, y2: 21 }),
    h('line', { x1: 12, y1: 17, x2: 12, y2: 21 })
  ),
  plus: () => h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
    h('line', { x1: 12, y1: 5, x2: 12, y2: 19 }),
    h('line', { x1: 5, y1: 12, x2: 19, y2: 12 })
  ),
  undo: () => h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
    h('path', { d: 'M3 7v6h6' }),
    h('path', { d: 'M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13' })
  ),
  redo: () => h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
    h('path', { d: 'M21 7v6h-6' }),
    h('path', { d: 'M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7' })
  ),
  sparkle: () => h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
    h('path', { d: 'M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z' })
  ),
  layers: () => h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
    h('polygon', { points: '12 2 2 7 12 12 22 7 12 2' }),
    h('polyline', { points: '2 17 12 22 22 17' }),
    h('polyline', { points: '2 12 12 17 22 12' })
  ),
}

function cleanErrorMessage(err) {
  let msg = err?.message || String(err || '') || '操作失败，已保存版本仍保留'
  msg = msg.replace(/^Error invoking remote method '[^']+':\s*/i, '')
  msg = msg.replace(/^Error:\s*/i, '')
  const httpMatch = msg.match(/^(\d{3}):\s*(.*)$/s)
  if (httpMatch) {
    const [, status, body] = httpMatch
    try {
      const parsed = JSON.parse(body)
      if (parsed.detail) {
        if (typeof parsed.detail === 'string') return parsed.detail
        if (Array.isArray(parsed.detail)) {
          const details = parsed.detail.map(d => `${d.loc?.filter(x => x !== 'body').join('.') || '参数'}: ${d.msg}`).join('; ')
          return `内容校验未通过 (${status}): ${details}`
        }
        return JSON.stringify(parsed.detail)
      }
    } catch {
      if (body.trim()) return body.trim()
    }
    if (status === '422') return '生成内容格式校验失败，请重试或简化提示词'
    if (status === '500') return '服务处理异常，请稍后重试'
  }
  return msg
}

function controller(ctx, owner) {
  const state = {
    owner, ctx, $doc: atom(null), $slide: atom(null), $selection: atom([]), $numbers: atom(true),
    $busy: atom(null), $error: atom(''), $messages: atom([]), $draft: atom(''),
    $before: atom(null), $compare: atom(false), $refresh: atom(0),
  }
  const assertOwner = () => { if (ownerKey() !== owner) throw new Error('连接已切换，请在当前工作区重新操作') }
  state.request = (path, options) => { assertOwner(); return ctx.rest(path, options) }
  state.accept = result => {
    if (!result?.deck) return
    const previous = state.$doc.get()
    if (previous?.deck.id === result.deck.id && previous.revision > result.revision) return
    state.$doc.set(result)
    if (!result.deck.slides.some(s => s.id === state.$slide.get())) state.$slide.set(result.deck.slides[0].id)
    const ids = new Set([...flatten(result.deck.master.elements), ...result.deck.slides.flatMap(s => flatten(s.elements))].map(e => e.id))
    state.$selection.set(state.$selection.get().filter(id => ids.has(id)))
    state.$compare.set(false)
    ctx.storage.set(`project:${owner}`, result.deck.id)
    state.$refresh.set(state.$refresh.get() + 1)
  }
  state.perform = async (label, fn) => {
    if (state.$busy.get()) return
    const operationId = uid()
    state.$busy.set({ label, requestId: null, operationId })
    state.$error.set('')
    try { await fn() } catch (error) { if (state.$busy.get()?.operationId === operationId) state.$error.set(cleanErrorMessage(error)) }
    finally { if (state.$busy.get()?.operationId === operationId) state.$busy.set(null) }
  }
  state.edit = (operations, label = '修改文稿') => state.perform(label, async () => {
    const current = state.$doc.get()
    if (!current) return
    const result = await state.request(`/projects/${current.deck.id}/edit`, { method: 'POST', body: {
      revision: current.revision, operations, label, request_id: uid(),
    } })
    state.accept(result)
  })
  state.load = id => state.perform('打开文稿', async () => {
    const result = await state.request(`/projects/${id}`)
    state.$selection.set([])
    state.$messages.set([])
    state.$before.set(null)
    state.accept(result)
  })
  state.create = () => state.perform('创建文稿', async () => {
    state.$selection.set([])
    state.$messages.set([])
    state.accept(await state.request('/projects', { method: 'POST', body: { name: '未命名演示文稿', request_id: uid() } }))
  })
  state.send = () => state.perform('正在理解指令并更新文稿…', async () => {
    const prompt = state.$draft.get().trim()
    if (!prompt) return
    const current = state.$doc.get()
    const requestId = uid()
    state.$busy.set({ ...state.$busy.get(), label: current ? '正在理解指令并更新文稿…' : '正在生成页面…', requestId })
    state.$messages.set([...state.$messages.get(), { role: 'user', text: prompt }])
    state.$draft.set('')
    const value = await state.request('/chat', { method: 'POST', timeoutMs: 150000, body: {
      prompt, project_id: current?.deck.id || null, revision: current?.revision || null,
      selection: state.$selection.get(), request_id: requestId,
    } })
    if (state.$busy.get()?.requestId !== requestId) return
    if (value.result) state.accept(value.result)
    state.$messages.set([...state.$messages.get(), { role: 'assistant', text: value.message }])
  })
  state.cancel = async () => {
    const current = state.$busy.get()
    if (!current?.requestId) return
    try {
      const result = await state.request('/cancel', { method: 'POST', body: { request_id: current.requestId } })
      if (result.result) state.accept(result.result)
      state.$messages.set([...state.$messages.get(), { role: 'assistant', text: result.cancelled ? '已取消，本次指令不会修改原稿。' : '本次修改已经保存，可以使用撤销恢复。' }])
      state.$busy.set(null)
    } catch (error) { state.$error.set(cleanErrorMessage(error)) }
  }
  state.travel = direction => state.perform(direction === 'undo' ? '撤销修改' : '重做修改', async () => {
    const current = state.$doc.get()
    state.accept(await state.request(`/projects/${current.deck.id}/${direction}`, { method: 'POST', body: {
      revision: current.revision, request_id: uid(),
    } }))
  })
  state.download = format => state.perform('正在准备下载…', async () => {
    const current = state.$doc.get()
    const file = await state.request(`/projects/${current.deck.id}/download?revision=${current.revision}&format=${format}`, { timeoutMs: 60000 })
    const bytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: file.content_type }))
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = file.filename
    document.body.appendChild(anchor); anchor.click(); anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  })
  state.importFile = file => state.perform('导入文稿', async () => {
    const result = await state.request('/import', { method: 'POST', timeoutMs: 60000, body: {
      data: await fileData(file), format: file.name.toLowerCase().endsWith('.pptx') ? 'pptx' : 'project', request_id: uid(),
    } })
    state.$selection.set([]); state.$messages.set([]); state.accept(result)
  })
  return state
}

function Toolbar({ c }) {
  const doc = useValue(c.$doc), busy = useValue(c.$busy), numbers = useValue(c.$numbers)
  const upload = useRef(null)
  return h('header', { className: 'ppt-toolbar' },
    h('div', { className: 'ppt-brand' },
      h('div', { className: 'ppt-brand-icon' }, Icon.ppt()),
      h('strong', null, 'PPT 创作台'),
    ),
    doc && h('div', { className: 'ppt-doc-badge' },
      h('span', { className: 'ppt-status-dot' }),
      h('span', { className: 'ppt-muted' }, `${doc.deck.name} · v${doc.revision} · 已保存`),
    ),
    h('div', { style: { flex: 1 } }),
    h('div', { className: 'ppt-btn-group' },
      button('空白新建', c.create, !!busy),
      button('导入', () => upload.current.click(), !!busy),
    ),
    h('input', { ref: upload, type: 'file', accept: '.pptx,.forxppt', hidden: true, onChange: event => {
      const file = event.target.files[0]; event.target.value = ''; if (file) void c.importFile(file)
    } }),
    doc && h('select', { className: 'ppt-theme-select', 'aria-label': 'PPT 主题', disabled: !!busy,
      value: Object.keys({ business: 1, technology: 1, minimal: 1 }).find(k => ({ business: '商务简洁', technology: '深色科技', minimal: '清新极简' })[k] === doc.deck.theme.name) || '',
      onChange: event => void c.edit([{ action: 'theme', changes: { preset: event.target.value } }], '切换文稿主题') },
      h('option', { value: '', disabled: true }, '选择主题风格'),
      h('option', { value: 'business' }, '💼 商务简洁'),
      h('option', { value: 'technology' }, '⚡ 深色科技'),
      h('option', { value: 'minimal' }, '🌿 清新极简')
    ),
    doc && h('div', { className: 'ppt-btn-group' },
      button(numbers ? '隐藏编号' : '显示编号', () => c.$numbers.set(!c.$numbers.get())),
      button('撤销', () => c.travel('undo'), !!busy || !doc?.undo_available),
      button('重做', () => c.travel('redo'), !!busy || !doc?.redo_available),
    ),
    doc && h('div', { className: 'ppt-btn-group' },
      button('保存项目', () => c.download('project'), !!busy || !doc),
      button('导出 PPTX', () => c.download('pptx'), !!busy || !doc, { className: 'ppt-btn-primary' }),
    ),
  )
}

function useView(c, doc, slideId, numbers, enabled = true) {
  const client = useQueryClient()
  return useQuery({
    queryKey: ['forx-ppt', c.owner, 'view', doc?.deck.id, doc?.revision, slideId, numbers],
    enabled: !!doc && !!slideId && enabled, retry: 1, staleTime: Infinity,
    queryFn: async () => {
      const data = await c.request(`/projects/${doc.deck.id}/preview/${slideId}?revision=${doc.revision}&numbers=${numbers}`)
      let svg = data.svg
      for (const id of data.assets) {
        const asset = await client.fetchQuery({ queryKey: ['forx-ppt', c.owner, 'asset', id], staleTime: Infinity,
          queryFn: () => c.request(`/assets/${id}`) })
        svg = svg.replaceAll(`forx-asset:${id}`, `data:${asset.content_type};base64,${asset.data}`)
      }
      return { ...data, svg }
    },
  })
}

function Thumbnail({ c, doc, slide, index }) {
  const selected = useValue(c.$slide)
  const view = useView(c, doc, slide.id, false)
  const isSelected = selected === slide.id
  return h('button', { className: `ppt-thumb ppt-thumb-card ${isSelected ? 'ppt-active' : ''}`, onClick: () => {
    c.$slide.set(slide.id); c.$selection.set([]); c.$compare.set(false)
  }, 'aria-label': `第 ${index + 1} 页 ${slide.id}` },
    h('div', { className: 'ppt-thumb-badge' }, String(index + 1).padStart(2, '0')),
    view.data ? h('div', { className: 'ppt-mini', dangerouslySetInnerHTML: { __html: view.data.svg } }) : h('div', { className: 'ppt-mini ppt-muted' }, view.error ? '预览失败' : '加载中…'),
    h('div', { className: 'ppt-thumb-info' },
      h('span', { className: 'ppt-thumb-title' }, `${index + 1} · ${slide.id} · ${slide.name}`)
    )
  )
}

function Navigation({ c }) {
  const doc = useValue(c.$doc), refresh = useValue(c.$refresh)
  const projects = useQuery({ queryKey: ['forx-ppt', c.owner, 'projects', refresh], queryFn: () => c.request('/projects'), refetchInterval: 5000, retry: 1 })
  return h('aside', { className: 'ppt-pages' },
    h('div', { className: 'ppt-pages-header' },
      h('label', null, '我的文稿'),
      doc && h('span', { className: 'ppt-pill-badge' }, `${doc.deck.slides.length} 页`)
    ),
    h('select', { className: 'ppt-project-select', 'aria-label': '打开文稿', value: doc?.deck.id || '', onChange: event => void c.load(event.target.value) },
      h('option', { value: '', disabled: true }, '选择已保存文稿'),
      ...(projects.data?.projects || []).map(p => h('option', { key: p.id, value: p.id }, p.name))),
    doc && button('＋ 新增页面', () => c.edit([{ action: 'add_slide', slide: { title: '新页面', bullets: [] } }], '新增页面'), !!c.$busy.get(), { className: 'ppt-add-slide-btn' }),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' } },
      ...(doc?.deck.slides || []).map((slide, i) => h(Thumbnail, { key: slide.id, c, doc, slide, index: i }))
    ),
  )
}

function Canvas({ c }) {
  const doc = useValue(c.$doc), slideId = useValue(c.$slide), numbers = useValue(c.$numbers)
  const selection = useValue(c.$selection), compare = useValue(c.$compare), before = useValue(c.$before)
  const view = useView(c, doc, slideId, numbers)
  const previous = useRef(null)
  useEffect(() => {
    if (!view.data || !doc) return
    const old = previous.current
    if (old?.project === doc.deck.id && old.slide === slideId && old.revision < doc.revision) c.$before.set(old)
    previous.current = { project: doc.deck.id, slide: slideId, revision: doc.revision, svg: view.data.svg }
  }, [view.data, doc, slideId, c])

  if (!doc) return h('main', { className: 'ppt-canvas-area' },
    h('div', { className: 'ppt-empty ppt-empty-hero' },
      h('div', { className: 'ppt-empty-icon' }, Icon.ppt()),
      h('h2', null, '把想表达的内容变成可编辑 PPT'),
      h('p', null, '在右侧描述主题、受众和页数，或创建空白文稿。'),
      h('p', { className: 'ppt-muted' }, '支持稳定编号、母版联动、局部修改与实时换主题。'),
      h('div', { className: 'ppt-suggestion-grid' },
        h('button', { className: 'ppt-suggestion-chip', onClick: () => c.$draft.set('生成一份 8 页的区块链技术架构与应用前景介绍。') },
          h('span', null, '🚀 生成一份 8 页的区块链技术与架构介绍'),
          h('small', { className: 'ppt-muted' }, '点击填入')
        ),
        h('button', { className: 'ppt-suggestion-chip', onClick: () => c.$draft.set('生成一份 10 页的企业产品方案与商业商业计划书。') },
          h('span', null, '💼 生成一份 10 页的企业商业计划书与方案'),
          h('small', { className: 'ppt-muted' }, '点击填入')
        ),
        h('button', { className: 'ppt-suggestion-chip', onClick: () => c.$draft.set('生成一份 5 页的团队年度成果与数据总结。') },
          h('span', null, '📊 生成一份 5 页的团队年度工作成果与数据'),
          h('small', { className: 'ppt-muted' }, '点击填入')
        )
      )
    )
  )

  const showingBefore = compare && before?.project === doc.deck.id && before.slide === slideId
  const svg = showingBefore ? before.svg : view.data?.svg
  const boxes = (view.data?.elements || []).filter(e => selection.includes(e.id))

  return h('main', { className: 'ppt-canvas-area' },
    h('div', { className: 'ppt-stage-header' },
      h('div', { className: 'ppt-stage-title' },
        h('span', { className: 'ppt-pill-badge' }, slideId),
        h('span', null, doc.deck.slides.find(s => s.id === slideId)?.name || '当前幻灯片')
      ),
      h('div', { style: flex },
        before?.project === doc.deck.id && before?.slide === slideId && button(showingBefore ? '返回当前版本' : '查看修改前', () => c.$compare.set(!c.$compare.get())),
        showingBefore && h('span', { className: 'ppt-muted' }, `修改前 v${before.revision}`),
        button('复制本页', () => c.edit([{ action: 'duplicate_slide', target: c.$slide.get() }], '复制页面'), !!c.$busy.get()),
        button('删除本页', () => c.edit([{ action: 'delete_slide', target: c.$slide.get() }], '删除页面'), !!c.$busy.get() || doc.deck.slides.length <= 1),
        button('前移', () => { const d = c.$doc.get(); return c.edit([{ action: 'move_slide', target: c.$slide.get(), index: Math.max(0, d.deck.slides.findIndex(s => s.id === c.$slide.get()) - 1) }], '页面前移') }, !!c.$busy.get()),
        button('后移', () => { const d = c.$doc.get(); return c.edit([{ action: 'move_slide', target: c.$slide.get(), index: Math.min(d.deck.slides.length - 1, d.deck.slides.findIndex(s => s.id === c.$slide.get()) + 1) }], '页面后移') }, !!c.$busy.get())
      )
    ),
    h('div', { className: 'ppt-canvas ppt-canvas-wrapper', style: { aspectRatio: `${doc.deck.width}/${doc.deck.height}` },
      onClick: event => {
        if (showingBefore) return
        const id = event.target.closest?.('[data-element-id]')?.dataset.elementId
        const current = c.$selection.get()
        c.$selection.set(id ? (event.ctrlKey || event.metaKey ? (current.includes(id) ? current.filter(v => v !== id) : [...current, id]) : [id]) : [])
      } },
      svg ? h('div', { className: 'ppt-svg', dangerouslySetInnerHTML: { __html: svg } }) : h('p', { role: view.error ? 'alert' : 'status', style: { padding: 32 } }, view.error?.message || '正在更新预览…'),
      !showingBefore && !!boxes.length && h('svg', { className: 'ppt-selection', viewBox: `0 0 ${doc.deck.width * 72} ${doc.deck.height * 72}` },
        ...boxes.map(e => h('rect', { key: e.id, x: e.box.x * 72, y: e.box.y * 72, width: e.box.width * 72, height: e.box.height * 72, fill: 'none', stroke: 'var(--ui-accent)', strokeWidth: 2, strokeDasharray: '6 3' }))
      )
    ),
    h('div', { className: 'ppt-canvas-footer' },
      h('span', { className: 'ppt-muted' }, '结构预览 · 导出保留原生对象 · 外部软件字体与排版可能有差异'),
      doc.change && h('span', { className: 'ppt-muted' }, `影响 ${doc.change.slides.length} 页、${doc.change.elements.length} 个对象`),
    ),
    ...(doc.issues || []).filter(i => i.slide_id === slideId).map((issue, i) => h('button', { key: i, className: 'ppt-issue', onClick: () => c.$selection.set([issue.element_id]) }, `${issue.element_id}：${issue.message}`)),
  )
}

function Properties({ c }) {
  const doc = useValue(c.$doc), selection = useValue(c.$selection), slideId = useValue(c.$slide), busy = useValue(c.$busy)
  const [search, setSearch] = useState(''), [text, setText] = useState(''), [name, setName] = useState(''), [fontSize, setFontSize] = useState(''), [masterSize, setMasterSize] = useState('32')
  const upload = useRef(null)
  const slide = doc?.deck.slides.find(s => s.id === slideId)
  const elements = doc ? [...flatten(doc.deck.master.elements).map(e => ({ ...e, source: 'M001' })), ...flatten(slide?.elements || []).map(e => ({ ...e, source: slideId }))] : []
  const chosen = selection.length === 1 ? elements.find(e => e.id === selection[0]) : null
  useEffect(() => { setText(chosen?.text || ''); setName(chosen?.name || ''); setFontSize(String(chosen?.style?.font_size || '')) }, [chosen?.id, chosen?.text, chosen?.name, chosen?.style?.font_size])
  if (!doc) return null
  return h('section', { className: 'ppt-properties ppt-panel-section' },
    h('div', { className: 'ppt-panel-header' },
      h('h3', null, '元素与母版'),
      h('span', { className: 'ppt-pill-badge' }, `${elements.length} 个元素`)
    ),
    h(Input, { value: search, onChange: event => setSearch(event.target.value), placeholder: '查找编号或名称', 'aria-label': '查找元素' }),
    h('div', { className: 'ppt-elements ppt-element-chips' }, ...elements.filter(e => `${e.id} ${e.name}`.toLowerCase().includes(search.toLowerCase())).map(e => h('button', {
      key: e.id, className: `ppt-elem-chip ${selection.includes(e.id) ? 'ppt-active' : ''}`, onClick: () => c.$selection.set([e.id]),
    }, `${e.id} · ${e.name}`, h('small', null, `${e.source === 'M001' ? '母版' : e.role ? '占位符' : e.kind}${e.visible === false ? ' (藏)' : ''}`)))),
    chosen && h('div', { className: 'ppt-fields ppt-inspector-card' },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
        h('strong', { style: { fontSize: 13, color: 'var(--ui-accent)' } }, chosen.id),
        h('span', { className: 'ppt-pill-badge' }, chosen.source === 'M001' ? '母版全局' : '本页独立')
      ),
      chosen.source === 'M001' && h('p', { className: 'ppt-muted', style: { margin: 0 } }, `来自主母版，修改会影响全篇 ${doc.deck.slides.length} 页。`),
      h('div', { className: 'ppt-form-row' },
        h('label', { className: 'ppt-field-label' }, '元素名称',
          h(Input, { value: name, onChange: event => setName(event.target.value) })
        ),
        button('修改名称', () => c.edit([{ action: 'update_element', target: c.$selection.get()[0], changes: { name } }], '修改元素名称'), !!busy || !name)
      ),
      chosen.kind === 'text' && h('div', { className: 'ppt-form-row' },
        h('label', { className: 'ppt-field-label' }, '文字',
          h(Textarea, { value: text, onChange: event => setText(event.target.value), rows: 3 })
        ),
        button(chosen.source === 'M001' ? '更新母版文字' : '更新本页文字', () => c.edit([{ action: 'update_element', target: c.$selection.get()[0], changes: { text } }], '更新文字'), !!busy)
      ),
      ['text', 'table', 'chart'].includes(chosen.kind) && h('div', { className: 'ppt-form-row' },
        h('label', { className: 'ppt-field-label' }, '局部字号（磅）',
          h(Input, { type: 'number', min: 8, max: 160, value: fontSize, placeholder: '继承', onChange: event => setFontSize(event.target.value) })
        ),
        h('div', { style: { display: 'flex', gap: 6 } },
          button('设置字号', () => c.edit([{ action: 'update_element', target: c.$selection.get()[0], changes: { style: { font_size: Number(fontSize) } } }], '设置局部字号'), !!busy || !fontSize),
          button('字号恢复继承', () => c.edit([{ action: 'reset_style', target: c.$selection.get()[0], properties: ['font_size'] }], '恢复字号继承'), !!busy)
        )
      ),
      h('p', { className: 'ppt-muted', style: { margin: 0 } }, `本地覆盖：${Object.entries(chosen.style).filter(([, value]) => value !== null).map(([key]) => key).join('、') || '无'}`),
      h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
        button('引用到对话', () => c.$draft.set(`${c.$draft.get()} ${chosen.source}/${chosen.id} `)),
        button('删除元素', () => c.edit([{ action: 'delete_element', target: c.$selection.get()[0] }], '删除元素'), !!busy)
      )
    ),
    h('div', { className: 'ppt-fields ppt-inspector-card' },
      h('strong', null, '主母版 · M001 全局设定'),
      h('div', { className: 'ppt-form-row' },
        h('label', { className: 'ppt-field-label' }, '统一标题字号',
          h(Input, { type: 'number', min: 8, max: 160, value: masterSize, onChange: event => setMasterSize(event.target.value) })
        ),
        button('应用到继承母版的标题', () => c.edit([{ action: 'master_style', target: 'title', changes: { font_size: Number(masterSize) } }], '统一母版标题字号'), !!busy)
      ),
      h('p', { className: 'ppt-muted', style: { margin: 0 } }, '本页字号覆盖会保留。可在对话中修改标题、正文、版式与公共对象。'),
      button(chosen?.kind === 'image' ? '替换选中图片' : '插入图片', () => upload.current.click(), !!busy),
      h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, ref: upload,
        onChange: event => {
          const file = event.target.files[0]; event.target.value = ''; if (!file) return
          void c.perform('上传图片', async () => {
            const target = c.$selection.get()[0]
            const d = c.$doc.get()
            const existing = [...flatten(d.deck.master.elements), ...d.deck.slides.flatMap(s => flatten(s.elements))].find(e => e.id === target)
            const asset = await c.request('/assets', { method: 'POST', body: { data: await fileData(file) } })
            const scale = Math.min(Math.min(4.5, d.deck.width - 1.2) / asset.width, 4.5 / asset.height)
            const width = asset.width * scale, height = asset.height * scale
            const operation = existing?.kind === 'image'
              ? { action: 'update_element', target, changes: { asset_id: asset.asset_id } }
              : { action: 'add_element', slide_id: c.$slide.get(), element: { kind: 'image', name: file.name.slice(0, 128), asset_id: asset.asset_id, box: { x: d.deck.width - width - 0.6, y: 2, width, height } } }
            c.accept(await c.request(`/projects/${d.deck.id}/edit`, { method: 'POST', body: { revision: d.revision, operations: [operation], request_id: uid(), label: '插入或替换图片' } }))
          })
        } }),
    ),
  )
}

function Conversation({ c }) {
  const doc = useValue(c.$doc), draft = useValue(c.$draft), messages = useValue(c.$messages), busy = useValue(c.$busy), error = useValue(c.$error), selection = useValue(c.$selection)
  const history = useQuery({ queryKey: ['forx-ppt', c.owner, 'history', doc?.deck.id, doc?.revision], enabled: !!doc,
    queryFn: () => c.request(`/projects/${doc.deck.id}/history`), retry: 1 })
  return h('section', { className: 'ppt-chat ppt-panel-section' },
    h('div', { className: 'ppt-panel-header' },
      h('h3', null, '对话编辑'),
      h('span', { className: 'ppt-pill-badge' }, busy ? '正在生成…' : '就绪')
    ),
    h('div', { className: 'ppt-messages ppt-messages-box', 'aria-live': 'polite' },
      !messages.length && h('div', { className: 'ppt-msg-bubble ppt-msg-assistant' },
        h('p', { style: { margin: 0, fontWeight: 500 } }, '✨ AI 幻灯片设计助手已就绪'),
        h('p', { className: 'ppt-muted', style: { margin: '4px 0 0' } }, '支持自然语言指令：\n• 生成一份 8 页的产品介绍\n• 将母版标题设为 34 磅\n• 只修改 E0017 为深色强调\n• 全篇换成深色科技风')
      ),
      ...messages.map((m, i) => h('div', { key: i, className: `ppt-msg-bubble ${m.role === 'user' ? 'ppt-user-message ppt-msg-user' : 'ppt-msg-assistant'}` },
        h('strong', null, m.role === 'user' ? '你：' : 'PPT：'),
        m.text
      )),
      busy && h('div', { role: 'status', className: 'ppt-msg-bubble ppt-msg-assistant', style: flex },
        h(GlyphSpinner),
        h('span', null, busy.label)
      ),
      error && h('p', { role: 'alert', className: 'ppt-error' }, error)
    ),
    h('p', { className: 'ppt-muted', style: { margin: '2px 0 0' } }, selection.length ? `已选中：${selection.join('、')}` : doc ? '未选择对象；可按页码、名称或稳定编号描述目标。' : '描述主题、受众与总页数后生成初稿。'),
    h('div', { className: 'ppt-chat-input-box' },
      h(Textarea, { value: draft, rows: 3, disabled: !!busy, placeholder: doc ? '描述本次修改…' : '生成一份……', 'aria-label': 'PPT 对话指令',
        onChange: event => c.$draft.set(event.target.value), onKeyDown: event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void c.send() } } }),
      h('div', { className: 'ppt-input-footer' },
        h('small', { className: 'ppt-muted' }, 'Ctrl+Enter 发送'),
        h('div', { style: flex },
          busy?.requestId && button('取消本次指令', c.cancel),
          button(doc ? '发送修改' : '生成初稿', c.send, !!busy || !draft.trim(), { className: 'ppt-btn-primary' })
        )
      )
    ),
    !!history.data?.history.length && h('details', { style: { marginTop: 4 } },
      h('summary', { style: { cursor: 'pointer', fontSize: 12, color: 'var(--ui-text-secondary)', fontWeight: 500 } }, '📜 已保存修改记录'),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 } },
        ...history.data.history.slice(0, 15).map(item => h('div', { key: item.version, style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', borderRadius: 6, background: 'var(--ui-bg-elevated)', border: '1px solid var(--ui-stroke-secondary)' } },
          h('span', { className: 'ppt-muted' }, `v${item.version} · ${item.label}`),
          item.version !== doc.revision && button('恢复此版本', () => c.perform('恢复历史版本', async () => {
            const latest = c.$doc.get()
            c.accept(await c.request(`/restore/${latest.deck.id}`, { method: 'POST', body: { revision: latest.revision, version: item.version, request_id: uid() } }))
          }), !!busy)
        ))
      )
    ),
  )
}

const css = `
.forx-ppt{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--ui-bg-base);color:var(--ui-text-primary);font-size:13px;line-height:1.5;user-select:none}
.forx-ppt h3{font-size:13px;font-weight:600;margin:0}
.forx-ppt p{line-height:1.6}
.forx-ppt select{max-width:100%;border:1px solid var(--ui-stroke-secondary);border-radius:6px;padding:5px 8px;background:var(--ui-bg-base);color:var(--ui-text-primary);font-size:12px}

/* Toolbar */
.ppt-toolbar{height:52px;min-height:52px;display:flex;align-items:center;gap:10px;padding:0 16px;background:color-mix(in srgb, var(--ui-bg-base) 85%, var(--ui-bg-elevated));border-bottom:1px solid var(--ui-stroke-secondary);backdrop-filter:blur(8px);z-index:10}
.ppt-brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:14px;letter-spacing:-0.2px;color:var(--ui-text-primary)}
.ppt-brand-icon{width:26px;height:26px;border-radius:6px;background:linear-gradient(135deg, var(--ui-accent), color-mix(in srgb, var(--ui-accent) 60%, #ec4899));color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px color-mix(in srgb, var(--ui-accent) 30%, transparent)}
.ppt-doc-badge{display:flex;align-items:center;gap:7px;padding:4px 10px;border-radius:9999px;background:color-mix(in srgb, var(--ui-bg-elevated) 80%, transparent);border:1px solid var(--ui-stroke-secondary);font-size:12px;color:var(--ui-text-secondary)}
.ppt-status-dot{width:7px;height:7px;border-radius:50%;background:#10b981;box-shadow:0 0 6px rgba(16,185,129,0.6);animation:ppt-pulse 2s infinite ease-in-out}
@keyframes ppt-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(0.85)}}

.ppt-btn-group{display:flex;align-items:center;background:var(--ui-bg-elevated);border:1px solid var(--ui-stroke-secondary);border-radius:8px;padding:2px;gap:2px}
.ppt-btn-group button{border:none!important;background:transparent!important;border-radius:6px!important;padding:4px 9px!important;height:28px!important;font-size:12px!important}
.ppt-btn-group button:hover:not(:disabled){background:color-mix(in srgb, var(--ui-text-primary) 10%, transparent)!important}
.ppt-theme-select{padding:5px 10px;border-radius:8px;border:1px solid var(--ui-stroke-secondary);background:var(--ui-bg-elevated);color:var(--ui-text-primary);font-size:12px;font-weight:500;cursor:pointer;outline:none}
.ppt-btn-primary{background:var(--ui-accent)!important;color:#fff!important;border-radius:8px!important;font-weight:500!important;box-shadow:0 2px 8px color-mix(in srgb, var(--ui-accent) 30%, transparent)!important;border:none!important}
.ppt-btn-primary:hover:not(:disabled){filter:brightness(1.1)!important}

/* 3-column Layout */
.ppt-layout{display:grid;grid-template-columns:200px minmax(340px,1fr) 340px;flex:1;min-height:0;overflow:hidden}

/* Left Sidebar - Slides Navigation */
.ppt-pages{background:color-mix(in srgb, var(--ui-bg-base) 92%, var(--ui-bg-elevated));border-right:1px solid var(--ui-stroke-secondary);display:flex;flex-direction:column;padding:14px 12px;gap:12px;overflow-y:auto}
.ppt-pages-header{display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:600;color:var(--ui-text-secondary);text-transform:uppercase;letter-spacing:0.5px}
.ppt-project-select{width:100%;padding:6px 10px;border-radius:8px;border:1px solid var(--ui-stroke-secondary);background:var(--ui-bg-elevated);color:var(--ui-text-primary);font-size:12px;cursor:pointer;outline:none}
.ppt-add-slide-btn{width:100%;border-radius:8px;border:1px dashed var(--ui-stroke-primary)!important;background:transparent!important;padding:8px!important;font-size:12px!important;font-weight:500!important;color:var(--ui-text-secondary)!important;display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;transition:all 0.15s ease}
.ppt-add-slide-btn:hover:not(:disabled){border-color:var(--ui-accent)!important;color:var(--ui-accent)!important;background:color-mix(in srgb, var(--ui-accent) 8%, transparent)!important}

.ppt-thumb-card{position:relative;border-radius:8px;padding:6px;background:var(--ui-bg-elevated);border:1.5px solid transparent;display:flex;flex-direction:column;gap:6px;cursor:pointer;transition:all 0.18s ease;box-shadow:0 1px 4px rgba(0,0,0,0.06);text-align:left}
.ppt-thumb-card:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,0.1);border-color:color-mix(in srgb, var(--ui-stroke-secondary) 80%, var(--ui-accent))}
.ppt-thumb-card.ppt-active{border-color:var(--ui-accent);box-shadow:0 0 0 2px color-mix(in srgb, var(--ui-accent) 25%, transparent),0 4px 14px rgba(0,0,0,0.12);background:color-mix(in srgb, var(--ui-bg-elevated) 90%, var(--ui-accent))}
.ppt-thumb-badge{position:absolute;top:10px;left:10px;background:rgba(0,0,0,0.65);color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;backdrop-filter:blur(4px);z-index:2}
.ppt-mini{aspect-ratio:16/9;border-radius:5px;overflow:hidden;background:#111;position:relative}
.ppt-mini svg{width:100%;height:100%;display:block}
.ppt-thumb-info{display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--ui-text-secondary);padding:0 2px}
.ppt-thumb-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}

/* Center Stage */
.ppt-canvas-area{display:flex;flex-direction:column;height:100%;background:radial-gradient(circle, color-mix(in srgb, var(--ui-stroke-secondary) 60%, transparent) 1px, transparent 1px);background-size:24px 24px;overflow-y:auto;padding:20px;gap:14px;align-items:center;justify-content:flex-start}
.ppt-stage-header{width:100%;max-width:960px;display:flex;align-items:center;justify-content:space-between;background:color-mix(in srgb, var(--ui-bg-elevated) 85%, transparent);border:1px solid var(--ui-stroke-secondary);border-radius:10px;padding:8px 14px;backdrop-filter:blur(8px)}
.ppt-stage-title{font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px}
.ppt-canvas-wrapper{position:relative;width:100%;max-width:960px;box-shadow:0 16px 40px -10px rgba(0,0,0,0.35),0 0 0 1px var(--ui-stroke-secondary);border-radius:10px;overflow:hidden;background:#ffffff;flex-shrink:0}
.ppt-svg{position:absolute;inset:0;width:100%;height:100%}
.ppt-selection{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.ppt-canvas-footer{display:flex;align-items:center;gap:12px;font-size:11px;color:var(--ui-text-tertiary)}

/* Empty State Hero */
.ppt-empty-hero{max-width:580px;margin:auto;text-align:center;padding:40px 32px;background:color-mix(in srgb, var(--ui-bg-elevated) 90%, transparent);border:1px solid var(--ui-stroke-secondary);border-radius:16px;box-shadow:0 12px 36px rgba(0,0,0,0.1);display:flex;flex-direction:column;align-items:center;gap:14px}
.ppt-empty-icon{width:56px;height:56px;border-radius:14px;background:linear-gradient(135deg, color-mix(in srgb, var(--ui-accent) 25%, transparent), color-mix(in srgb, #8b5cf6 25%, transparent));color:var(--ui-accent);display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px color-mix(in srgb, var(--ui-accent) 20%, transparent)}
.ppt-empty-hero h2{font-size:18px;font-weight:700;margin:0;color:var(--ui-text-primary);letter-spacing:-0.2px}
.ppt-empty-hero p{color:var(--ui-text-secondary);margin:0;font-size:12.5px;max-width:440px;line-height:1.6}
.ppt-suggestion-grid{display:flex;flex-direction:column;gap:8px;width:100%;margin-top:6px}
.ppt-suggestion-chip{text-align:left;padding:9px 12px;border-radius:8px;background:color-mix(in srgb, var(--ui-bg-base) 70%, var(--ui-bg-elevated));border:1px solid var(--ui-stroke-secondary);font-size:12px;color:var(--ui-text-primary);display:flex;align-items:center;justify-content:space-between;cursor:pointer;transition:all 0.15s ease}
.ppt-suggestion-chip:hover{border-color:var(--ui-accent);background:color-mix(in srgb, var(--ui-accent) 10%, transparent);transform:translateX(2px)}

/* Right Sidebar */
.ppt-side{background:color-mix(in srgb, var(--ui-bg-base) 94%, var(--ui-bg-elevated));border-left:1px solid var(--ui-stroke-secondary);display:flex;flex-direction:column;overflow-y:auto;min-height:0}
.ppt-panel-section{padding:14px;display:flex;flex-direction:column;gap:10px;border-bottom:1px solid var(--ui-stroke-secondary)}
.ppt-panel-header{display:flex;align-items:center;justify-content:space-between;font-size:13px;font-weight:600;color:var(--ui-text-primary)}
.ppt-pill-badge{font-size:10px;padding:2px 7px;border-radius:9999px;background:color-mix(in srgb, var(--ui-accent) 15%, transparent);color:var(--ui-accent);font-weight:600}

/* Chat Section */
.ppt-messages-box{min-height:90px;max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:2px}
.ppt-msg-bubble{padding:8px 12px;border-radius:10px;font-size:12px;line-height:1.55;max-width:92%;word-break:break-word}
.ppt-msg-user{align-self:flex-end;background:color-mix(in srgb, var(--ui-accent) 18%, transparent);border:1px solid color-mix(in srgb, var(--ui-accent) 30%, transparent);color:var(--ui-text-primary);border-bottom-right-radius:2px}
.ppt-msg-assistant{align-self:flex-start;background:var(--ui-bg-elevated);border:1px solid var(--ui-stroke-secondary);color:var(--ui-text-primary);border-bottom-left-radius:2px}
.ppt-chat-input-box{border:1px solid var(--ui-stroke-secondary);border-radius:10px;background:var(--ui-bg-elevated);padding:8px;display:flex;flex-direction:column;gap:8px;transition:border-color 0.15s ease,box-shadow 0.15s ease}
.ppt-chat-input-box:focus-within{border-color:var(--ui-accent);box-shadow:0 0 0 2px color-mix(in srgb, var(--ui-accent) 20%, transparent)}
.ppt-chat-input-box textarea{border:none!important;background:transparent!important;padding:0!important;box-shadow:none!important;resize:none;font-size:12.5px;line-height:1.5;outline:none!important}
.ppt-input-footer{display:flex;align-items:center;justify-content:space-between;padding-top:4px;border-top:1px solid color-mix(in srgb, var(--ui-stroke-secondary) 50%, transparent)}

/* Properties */
.ppt-element-chips{display:flex;flex-wrap:wrap;gap:5px;max-height:130px;overflow-y:auto;padding:2px}
.ppt-elem-chip{padding:4px 8px;border-radius:6px;border:1px solid var(--ui-stroke-secondary);background:var(--ui-bg-elevated);color:var(--ui-text-secondary);font-size:11px;cursor:pointer;display:flex;align-items:center;gap:5px;transition:all 0.12s ease}
.ppt-elem-chip:hover{border-color:var(--ui-stroke-primary);color:var(--ui-text-primary)}
.ppt-elem-chip.ppt-active{border-color:var(--ui-accent);background:color-mix(in srgb, var(--ui-accent) 15%, transparent);color:var(--ui-accent);font-weight:500}
.ppt-inspector-card{background:var(--ui-bg-elevated);border:1px solid var(--ui-stroke-secondary);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:9px}
.ppt-form-row{display:flex;flex-direction:column;gap:6px}
.ppt-field-label{display:flex;flex-direction:column;gap:5px;font-size:11px;font-weight:500;color:var(--ui-text-secondary);width:100%}

.ppt-muted{color:var(--ui-text-tertiary);font-size:11px}
.ppt-error,.ppt-issue{color:var(--ui-text-primary);background:color-mix(in srgb, #ef4444 12%, transparent);border:1px solid color-mix(in srgb, #ef4444 35%, transparent);border-radius:8px;padding:8px 12px;text-align:left;font-size:12px;margin:0}
.ppt-connecting{padding:40px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:16px;max-width:480px;margin:auto}

@media(max-width:1100px){.ppt-layout{grid-template-columns:160px minmax(260px,1fr) 300px}}
@media(max-width:760px){.ppt-layout{grid-template-columns:minmax(240px,1fr) 280px}.ppt-pages{display:none}}
`

function Workbench({ c }) {
  const doc = useValue(c.$doc), busy = useValue(c.$busy), gateway = useValue(host.state.gateway)
  const restored = useRef(false)
  const status = useQuery({ queryKey: ['forx-ppt', c.owner, 'status', gateway], queryFn: () => c.request('/status'), enabled: gateway === 'open', retry: 1 })
  const current = useQuery({ queryKey: ['forx-ppt', c.owner, 'current', doc?.deck.id], enabled: !!doc && gateway === 'open' && !busy,
    queryFn: () => c.request(`/projects/${doc.deck.id}`), refetchInterval: 5000, retry: 1 })
  useEffect(() => { if (current.data && current.data.deck.id === c.$doc.get()?.deck.id && current.data.revision > c.$doc.get().revision) c.accept(current.data) }, [current.data, c])
  useEffect(() => {
    if (!status.data?.ready || restored.current) return
    restored.current = true
    const id = c.ctx.storage.get(`project:${c.owner}`, null)
    if (id && !c.$doc.get()) void c.load(id)
  }, [status.data, c])
  if (!status.data?.ready) return h('div', { className: 'ppt-connecting' },
    h('div', { className: 'ppt-brand-icon', style: { width: 44, height: 44 } }, Icon.ppt()),
    h('h2', null, 'PPT 创作台'),
    h('p', { role: status.error ? 'alert' : 'status' }, status.error ? `后端未就绪：${status.error.message}。请启用 forx-ppt 后端插件并重新启动后端。` : status.data ? '缺少 python-pptx 依赖，请在当前 ForX 运行环境安装插件依赖。' : '正在连接 PPT 插件后端…'),
    h('div', { style: flex },
      button('重新连接', () => status.refetch()),
      button('打开插件设置', () => host.navigate('/capabilities?tab=plugins'))
    )
  )
  return h('section', { className: 'forx-ppt', 'aria-label': 'PPT 创作台' }, h('style', null, css),
    h(Toolbar, { c }),
    h('div', { className: 'ppt-layout' },
      h(Navigation, { c }),
      h(Canvas, { c }),
      h('aside', { className: 'ppt-side' },
        h(Conversation, { c }),
        h(Properties, { c })
      )
    )
  )
}

function Page({ ctx, controllers }) {
  const connection = useValue(host.state.connectionId), profile = useValue(host.state.profile)
  const owner = JSON.stringify([connection, profile])
  if (!controllers.has(owner)) controllers.set(owner, controller(ctx, owner))
  return h(Workbench, { key: owner, c: controllers.get(owner) })
}

export default {
  id: 'forx-ppt', name: 'PPT 创作台', defaultEnabled: false,
  register(ctx) {
    const controllers = new Map()
    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: '/ppt' }, render: () => h(Page, { ctx, controllers }) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: '/ppt', label: 'PPT 创作台', codicon: 'preview' } },
      { id: 'open', area: PALETTE_AREA, data: { id: 'forx-ppt.open', label: '打开 PPT 创作台', keywords: ['ppt', '演示文稿', '幻灯片'], run: () => host.navigate('/ppt') } },
    ])
  },
}

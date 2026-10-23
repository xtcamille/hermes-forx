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
    h('strong', null, 'PPT 创作台'),
    doc && h('span', { className: 'ppt-muted' }, `${doc.deck.name} · v${doc.revision} · 已保存`),
    h('div', { style: { flex: 1 } }),
    button('空白新建', c.create, !!busy),
    button('导入', () => upload.current.click(), !!busy),
    h('input', { ref: upload, type: 'file', accept: '.pptx,.forxppt', hidden: true, onChange: event => {
      const file = event.target.files[0]; event.target.value = ''; if (file) void c.importFile(file)
    } }),
    doc && h('select', { 'aria-label': 'PPT 主题', disabled: !!busy, value: Object.keys({ business: 1, technology: 1, minimal: 1 }).find(k => ({ business: '商务简洁', technology: '深色科技', minimal: '清新极简' })[k] === doc.deck.theme.name) || '',
      onChange: event => void c.edit([{ action: 'theme', changes: { preset: event.target.value } }], '切换文稿主题') },
    h('option', { value: '', disabled: true }, '自定义主题'), h('option', { value: 'business' }, '商务简洁'), h('option', { value: 'technology' }, '深色科技'), h('option', { value: 'minimal' }, '清新极简')),
    button(numbers ? '隐藏编号' : '显示编号', () => c.$numbers.set(!c.$numbers.get())),
    button('撤销', () => c.travel('undo'), !!busy || !doc?.undo_available),
    button('重做', () => c.travel('redo'), !!busy || !doc?.redo_available),
    button('保存项目', () => c.download('project'), !!busy || !doc),
    button('导出 PPTX', () => c.download('pptx'), !!busy || !doc),
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
  return h('button', { className: `ppt-thumb ${selected === slide.id ? 'ppt-active' : ''}`, onClick: () => {
    c.$slide.set(slide.id); c.$selection.set([]); c.$compare.set(false)
  }, 'aria-label': `第 ${index + 1} 页 ${slide.id}` },
  view.data ? h('div', { className: 'ppt-mini', dangerouslySetInnerHTML: { __html: view.data.svg } }) : h('div', { className: 'ppt-mini ppt-muted' }, view.error ? '预览失败' : '加载中…'),
  h('span', null, `${index + 1} · ${slide.id} · ${slide.name}`))
}

function Navigation({ c }) {
  const doc = useValue(c.$doc), refresh = useValue(c.$refresh)
  const projects = useQuery({ queryKey: ['forx-ppt', c.owner, 'projects', refresh], queryFn: () => c.request('/projects'), refetchInterval: 5000, retry: 1 })
  return h('aside', { className: 'ppt-pages' },
    h('label', null, '我的文稿'),
    h('select', { 'aria-label': '打开文稿', value: doc?.deck.id || '', onChange: event => void c.load(event.target.value) },
      h('option', { value: '', disabled: true }, '选择已保存文稿'),
      ...(projects.data?.projects || []).map(p => h('option', { key: p.id, value: p.id }, p.name))),
    ...(doc?.deck.slides || []).map((slide, i) => h(Thumbnail, { key: slide.id, c, doc, slide, index: i })),
    doc && button('＋ 新增页面', () => c.edit([{ action: 'add_slide', slide: { title: '新页面', bullets: [] } }], '新增页面'), !!c.$busy.get()),
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
  if (!doc) return h('main', { className: 'ppt-empty' }, h('h2', null, '把想表达的内容变成可编辑 PPT'),
    h('p', null, '在右侧描述主题、受众和页数，或创建空白文稿。'),
    h('p', { className: 'ppt-muted' }, '支持稳定编号、母版联动、局部修改与实时换主题。'))
  const showingBefore = compare && before?.project === doc.deck.id && before.slide === slideId
  const svg = showingBefore ? before.svg : view.data?.svg
  const boxes = (view.data?.elements || []).filter(e => selection.includes(e.id))
  return h('main', { className: 'ppt-canvas-area' },
    h('div', { style: flex }, h('span', null, `${slideId} · ${doc.deck.slides.find(s => s.id === slideId)?.name || ''}`),
      before?.project === doc.deck.id && before?.slide === slideId && button(showingBefore ? '返回当前版本' : '查看修改前', () => c.$compare.set(!c.$compare.get())),
      showingBefore && h('span', { className: 'ppt-muted' }, `修改前 v${before.revision}`)),
    h('div', { className: 'ppt-canvas', style: { aspectRatio: `${doc.deck.width}/${doc.deck.height}` },
      onClick: event => {
        if (showingBefore) return
        const id = event.target.closest?.('[data-element-id]')?.dataset.elementId
        const current = c.$selection.get()
        c.$selection.set(id ? (event.ctrlKey || event.metaKey ? (current.includes(id) ? current.filter(v => v !== id) : [...current, id]) : [id]) : [])
      } },
    svg ? h('div', { className: 'ppt-svg', dangerouslySetInnerHTML: { __html: svg } }) : h('p', { role: view.error ? 'alert' : 'status' }, view.error?.message || '正在更新预览…'),
    !showingBefore && !!boxes.length && h('svg', { className: 'ppt-selection', viewBox: `0 0 ${doc.deck.width * 72} ${doc.deck.height * 72}` },
      ...boxes.map(e => h('rect', { key: e.id, x: e.box.x * 72, y: e.box.y * 72, width: e.box.width * 72, height: e.box.height * 72, fill: 'none', stroke: 'var(--ui-accent)', strokeWidth: 2, strokeDasharray: '6 3' })))),
    h('p', { className: 'ppt-muted' }, '结构预览 · 导出保留原生对象 · 外部软件字体与排版可能有差异'),
    doc.change && h('p', { className: 'ppt-muted' }, `本次修改影响 ${doc.change.slides.length} 页、${doc.change.elements.length} 个对象；${doc.change.preserved_overrides.length} 个对象保留显式样式。`),
    ...(doc.issues || []).filter(i => i.slide_id === slideId).map((issue, i) => h('button', { key: i, className: 'ppt-issue', onClick: () => c.$selection.set([issue.element_id]) }, `${issue.element_id}：${issue.message}`)),
    h('div', { style: flex },
      button('复制本页', () => c.edit([{ action: 'duplicate_slide', target: c.$slide.get() }], '复制页面'), !!c.$busy.get()),
      button('删除本页', () => c.edit([{ action: 'delete_slide', target: c.$slide.get() }], '删除页面'), !!c.$busy.get() || doc.deck.slides.length <= 1),
      button('前移', () => { const d = c.$doc.get(); return c.edit([{ action: 'move_slide', target: c.$slide.get(), index: Math.max(0, d.deck.slides.findIndex(s => s.id === c.$slide.get()) - 1) }], '页面前移') }, !!c.$busy.get()),
      button('后移', () => { const d = c.$doc.get(); return c.edit([{ action: 'move_slide', target: c.$slide.get(), index: Math.min(d.deck.slides.length - 1, d.deck.slides.findIndex(s => s.id === c.$slide.get()) + 1) }], '页面后移') }, !!c.$busy.get())),
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
  return h('section', { className: 'ppt-properties' },
    h('h3', null, '元素与母版'),
    h(Input, { value: search, onChange: event => setSearch(event.target.value), placeholder: '查找编号或名称', 'aria-label': '查找元素' }),
    h('div', { className: 'ppt-elements' }, ...elements.filter(e => `${e.id} ${e.name}`.toLowerCase().includes(search.toLowerCase())).map(e => h('button', {
      key: e.id, className: selection.includes(e.id) ? 'ppt-active' : '', onClick: () => c.$selection.set([e.id]),
    }, `${e.id} · ${e.name}`, h('small', null, `${e.source === 'M001' ? '母版 · 全篇' : e.role ? '占位符 · 本页' : e.kind}${e.visible === false ? ' · 已隐藏' : ''}`)))),
    chosen && h('div', { className: 'ppt-fields' },
      h('strong', null, chosen.id),
      chosen.source === 'M001' && h('p', { className: 'ppt-muted' }, `来自主母版，修改会影响 ${doc.deck.slides.length} 页。`),
      h('label', null, '元素名称', h(Input, { value: name, onChange: event => setName(event.target.value) })),
      button('修改名称', () => c.edit([{ action: 'update_element', target: c.$selection.get()[0], changes: { name } }], '修改元素名称'), !!busy || !name),
      chosen.kind === 'text' && h('label', null, '文字', h(Textarea, { value: text, onChange: event => setText(event.target.value), rows: 3 })),
      chosen.kind === 'text' && button(chosen.source === 'M001' ? '更新母版文字' : '更新本页文字', () => c.edit([{ action: 'update_element', target: c.$selection.get()[0], changes: { text } }], '更新文字'), !!busy),
      ['text', 'table', 'chart'].includes(chosen.kind) && h('label', null, '局部字号（磅）', h(Input, { type: 'number', min: 8, max: 160, value: fontSize, placeholder: '继承', onChange: event => setFontSize(event.target.value) })),
      ['text', 'table', 'chart'].includes(chosen.kind) && button('设置字号', () => c.edit([{ action: 'update_element', target: c.$selection.get()[0], changes: { style: { font_size: Number(fontSize) } } }], '设置局部字号'), !!busy || !fontSize),
      ['text', 'table', 'chart'].includes(chosen.kind) && button('字号恢复继承', () => c.edit([{ action: 'reset_style', target: c.$selection.get()[0], properties: ['font_size'] }], '恢复字号继承'), !!busy),
      h('p', { className: 'ppt-muted' }, `本地覆盖：${Object.entries(chosen.style).filter(([, value]) => value !== null).map(([key]) => key).join('、') || '无'}`),
      button('引用到对话', () => c.$draft.set(`${c.$draft.get()} ${chosen.source}/${chosen.id} `)),
      button('删除元素', () => c.edit([{ action: 'delete_element', target: c.$selection.get()[0] }], '删除元素'), !!busy),
    ),
    h('div', { className: 'ppt-fields' }, h('strong', null, '主母版 · M001'),
      h('label', null, '统一标题字号', h(Input, { type: 'number', min: 8, max: 160, value: masterSize, onChange: event => setMasterSize(event.target.value) })),
      button('应用到继承母版的标题', () => c.edit([{ action: 'master_style', target: 'title', changes: { font_size: Number(masterSize) } }], '统一母版标题字号'), !!busy),
      h('p', { className: 'ppt-muted' }, '本页字号覆盖会保留。可在对话中修改标题、正文、版式与公共对象。'),
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
  return h('section', { className: 'ppt-chat' }, h('h3', null, '对话编辑'),
    h('div', { className: 'ppt-messages', 'aria-live': 'polite' },
      !messages.length && h('p', { className: 'ppt-muted' }, '例如：生成一份 8 页的产品介绍；将母版标题设为 34 磅；只修改 E0017；全篇换成深色科技风。'),
      ...messages.map((m, i) => h('p', { key: i, className: m.role === 'user' ? 'ppt-user-message' : '' }, h('strong', null, m.role === 'user' ? '你：' : 'PPT：'), m.text)),
      busy && h('p', { role: 'status', style: flex }, h(GlyphSpinner), busy.label),
      error && h('p', { role: 'alert', className: 'ppt-error' }, error)),
    h('p', { className: 'ppt-muted' }, selection.length ? `已选中：${selection.join('、')}` : doc ? '未选择对象；可按页码、名称或稳定编号描述目标。' : '描述主题、受众与总页数后生成初稿。'),
    h(Textarea, { value: draft, rows: 3, disabled: !!busy, placeholder: doc ? '描述本次修改…' : '生成一份……', 'aria-label': 'PPT 对话指令',
      onChange: event => c.$draft.set(event.target.value), onKeyDown: event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void c.send() } } }),
    h('div', { style: flex }, button(doc ? '发送修改' : '生成初稿', c.send, !!busy || !draft.trim()), busy?.requestId && button('取消本次指令', c.cancel)),
    !!history.data?.history.length && h('details', null, h('summary', null, '已保存的修改记录'),
      ...history.data.history.slice(0, 20).map(item => h('div', { key: item.version },
        h('p', { className: 'ppt-muted' }, `v${item.version} · ${item.label}`),
        item.version !== doc.revision && button('恢复此版本', () => c.perform('恢复历史版本', async () => {
          const latest = c.$doc.get()
          c.accept(await c.request(`/restore/${latest.deck.id}`, { method: 'POST', body: { revision: latest.revision, version: item.version, request_id: uid() } }))
        }), !!busy)))),
  )
}

const css = `
.forx-ppt{height:100%;min-height:0;display:flex;flex-direction:column;color:var(--ui-text-primary);font-size:13px}
.forx-ppt h3{font-size:13px;font-weight:600;margin:8px 0}.forx-ppt p{line-height:1.65}.forx-ppt select{max-width:100%;border:1px solid var(--ui-stroke-secondary);border-radius:5px;padding:5px;background:var(--ui-bg-base);color:var(--ui-text-primary)}
.ppt-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:7px;padding:10px 14px;border-bottom:1px solid var(--ui-stroke-secondary)}
.ppt-layout{display:grid;grid-template-columns:160px minmax(280px,1fr) 300px;flex:1;min-height:0;overflow:auto}.ppt-pages{padding:12px;overflow:auto;border-right:1px solid var(--ui-stroke-secondary);display:flex;flex-direction:column;gap:10px}
.ppt-thumb{text-align:left;padding:5px;border:1px solid var(--ui-stroke-secondary);border-radius:5px;color:var(--ui-text-secondary);font-size:11px}.ppt-thumb span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:5px}.ppt-mini{aspect-ratio:16/9;overflow:hidden;width:100%}.ppt-mini svg{display:block;width:100%;height:100%}
.ppt-active{outline:2px solid var(--ui-accent);outline-offset:-2px}.ppt-canvas-area{padding:18px;overflow:auto;display:flex;flex-direction:column;gap:12px}.ppt-canvas{position:relative;width:100%;max-height:70vh;border:1px solid var(--ui-stroke-secondary);box-shadow:0 4px 18px var(--ui-shadow);flex-shrink:0}.ppt-svg{position:absolute;inset:0}.ppt-svg svg{display:block}.ppt-selection{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.ppt-side{display:flex;flex-direction:column;min-height:0;overflow:auto;border-left:1px solid var(--ui-stroke-secondary)}.ppt-properties,.ppt-chat{padding:12px}.ppt-properties{border-bottom:1px solid var(--ui-stroke-secondary)}.ppt-elements{max-height:180px;overflow:auto;margin:8px 0}.ppt-elements button{display:block;width:100%;text-align:left;padding:7px;color:var(--ui-text-secondary)}.ppt-elements small{display:block;color:var(--ui-text-tertiary);font-size:10px}.ppt-fields{display:flex;flex-direction:column;gap:7px;margin-top:12px}.ppt-fields label{display:flex;flex-direction:column;gap:4px}
.ppt-chat{display:flex;flex-direction:column;gap:8px;min-height:300px}.ppt-messages{min-height:80px;max-height:330px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}.ppt-user-message{color:var(--ui-accent)}.ppt-muted{color:var(--ui-text-tertiary);font-size:11px}.ppt-error,.ppt-issue{color:var(--ui-text-primary);border-left:3px solid var(--ui-accent);padding-left:8px;text-align:left}.ppt-empty{display:flex;flex-direction:column;justify-content:center;padding:32px;line-height:1.8}.ppt-connecting{padding:32px;display:flex;flex-direction:column;gap:16px}
@media(max-width:1050px){.ppt-layout{grid-template-columns:120px minmax(240px,1fr) 260px}.ppt-toolbar{padding:8px}.ppt-canvas-area{padding:10px}}
@media(max-width:760px){.ppt-layout{grid-template-columns:minmax(240px,1fr) 250px}.ppt-pages{display:none}}
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
  if (!status.data?.ready) return h('div', { className: 'ppt-connecting' }, h('h2', null, 'PPT 创作台'),
    h('p', { role: status.error ? 'alert' : 'status' }, status.error ? `后端未就绪：${status.error.message}。请启用 forx-ppt 后端插件并重新启动后端。` : status.data ? '缺少 python-pptx 依赖，请在当前 ForX 运行环境安装插件依赖。' : '正在连接 PPT 插件后端…'),
    button('重新连接', () => status.refetch()), button('打开插件设置', () => host.navigate('/capabilities?tab=plugins')))
  return h('section', { className: 'forx-ppt', 'aria-label': 'PPT 创作台' }, h('style', null, css),
    h(Toolbar, { c }), h('div', { className: 'ppt-layout' }, h(Navigation, { c }), h(Canvas, { c }), h('aside', { className: 'ppt-side' }, h(Conversation, { c }), h(Properties, { c }))))
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

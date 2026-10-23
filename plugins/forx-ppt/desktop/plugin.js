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
  sidebarLeft: () => h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
    h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }),
    h('line', { x1: 9, y1: 3, x2: 9, y2: 21 })
  ),
  sidebarRight: () => h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
    h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }),
    h('line', { x1: 15, y1: 3, x2: 15, y2: 21 })
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
    $leftOpen: atom(true), $rightOpen: atom(true), $panelTab: atom('all'),
    $docModalOpen: atom(false), $layoutModalOpen: atom(false),
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
  const leftOpen = useValue(c.$leftOpen), rightOpen = useValue(c.$rightOpen)
  const upload = useRef(null)
  return h('header', { className: 'ppt-toolbar' },
    h('div', { className: 'ppt-brand' },
      h('div', { className: 'ppt-brand-icon' }, Icon.ppt()),
      h('strong', null, 'PPT 创作台'),
    ),
    doc && h('div', { className: 'ppt-doc-badge' },
      h('span', { className: 'ppt-status-dot' }),
      h('span', { className: 'ppt-muted', title: `${doc.deck.name} · v${doc.revision}` }, `${doc.deck.name} · v${doc.revision} · 已保存`),
    ),
    h('div', { className: 'ppt-toolbar-spacer' }),
    h('div', { className: 'ppt-btn-group' },
      button(leftOpen ? '收起列表' : '页面列表', () => c.$leftOpen.set(!c.$leftOpen.get()), false, { className: leftOpen ? 'ppt-btn-active' : '' }),
      button(rightOpen ? '收起面板' : '展开面板', () => c.$rightOpen.set(!c.$rightOpen.get()), false, { className: rightOpen ? 'ppt-btn-active' : '' }),
    ),
    h('div', { className: 'ppt-btn-group' },
      button('空白新建', c.create, !!busy),
      button('文档转PPT', () => c.$docModalOpen.set(true), !!busy),
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

const LAYOUTS = [
  { id: 'L001', name: '封面页', icon: '🎯', desc: '大标题、副标题与主讲人', defaultTitle: '汇报主标题', bullets: ['副标题与核心主旨阐述', '汇报人 / 团队 / 日期'] },
  { id: 'L002', name: '目录导航', icon: '📑', desc: '全篇章节规划与导航条目', defaultTitle: '章节目录', bullets: ['01 项目背景与核心挑战', '02 系统架构与核心技术', '03 业务落地与运营成果', '04 下一步规划与未来展望'] },
  { id: 'L003', name: '标题正文', icon: '📝', desc: '单栏叙述、观点展开与要点', defaultTitle: '核心观点与阐述', bullets: ['核心观点或关键结论阐述', '支持性论据或实施步骤展开', '量化成果或具体落地指标'] },
  { id: 'L004', name: '图文双栏', icon: '🖼️', desc: '双栏结构、左右对比或图文并列', defaultTitle: '双栏重点提炼', bullets: ['维度一：核心技术能力深度自研', '维度二：跨系统高可用生态打通', '维度三：全流程监控与安全审计'] },
  { id: 'L006', name: '时间轴', icon: '⏳', desc: '发展历程与里程碑阶段规划', defaultTitle: '发展历程与演进路线', bullets: ['阶段一 (Q1)：需求调研与架构选型', '阶段二 (Q2)：原型研发与核心功能内测', '阶段三 (Q3)：业务试点上线与指标验证', '阶段四 (Q4)：全量推广与生态规模化'] },
  { id: 'L007', name: '多列卡片', icon: '🗂️', desc: '3-4项核心能力、业务支柱', defaultTitle: '三大核心支柱', bullets: ['核心支柱 1：模块化插件解耦体系', '核心支柱 2：全端自适应高质量排版', '核心支柱 3：端侧高安全隐私离线存储'] },
  { id: 'L008', name: '关键指标', icon: '📈', desc: '量化成果大屏与核心KPI战报', defaultTitle: '业务关键指标战报', bullets: ['99.99% 核心链路 SLA 可用性', '300% 创作与排版提效倍率', '50,000+ 累计服务企业与团队'] },
  { id: 'L009', name: '四象限/SWOT', icon: '🧭', desc: 'SWOT分析与象限评估矩阵', defaultTitle: 'SWOT 多维矩阵分析', bullets: ['优势 (S)：轻量架构与高效缓存机制', '劣势 (W)：初期外部生态插件库待扩展', '机会 (O)：大模型 Native 应用全面普及', '威胁 (T)：开源工具快速演进与技术同质化'] },
  { id: 'L010', name: '方案对比', icon: '⚖️', desc: '双方案/竞品优劣多维对比', defaultTitle: '多维方案优劣评估', bullets: ['方案 A (当前方案)：低改造成本、上线快、维护简单', '方案 B (重构方案)：弹性伸缩强、性能上限高、长期架构优秀'] },
  { id: 'L005', name: '结束致谢', icon: '🎉', desc: '总结、Q&A 与致谢页', defaultTitle: '致谢与交流', bullets: ['感谢各位专家与评委聆听！', '欢迎提问与深入探讨 (Q & A)'] },
]

function LayoutPickerModal({ c }) {
  const open = useValue(c.$layoutModalOpen)
  if (!open) return null
  const handleSelect = (l) => {
    c.$layoutModalOpen.set(false)
    c.edit([{
      action: 'add_slide',
      slide: {
        title: l.defaultTitle || l.name,
        layout_id: l.id,
        bullets: l.bullets || []
      }
    }], `新增页面 · ${l.name}`)
  }
  return h('div', { className: 'ppt-modal-backdrop', onClick: () => c.$layoutModalOpen.set(false) },
    h('div', { className: 'ppt-modal ppt-layout-modal', onClick: e => e.stopPropagation() },
      h('div', { className: 'ppt-modal-header' },
        h('div', null,
          h('h3', { className: 'ppt-modal-title' }, '选择新增页面版式 (10 类专业版式)'),
          h('p', { className: 'ppt-muted', style: { margin: '2px 0 0' } }, '点击卡片立即插入页面，自动填充规范结构与示范要点')
        ),
        button('✕', () => c.$layoutModalOpen.set(false), false, { className: 'ppt-btn-icon' })
      ),
      h('div', { className: 'ppt-layout-grid' },
        LAYOUTS.map(l => h('div', {
          key: l.id,
          className: 'ppt-layout-card',
          onClick: () => handleSelect(l)
        },
          h('div', { className: 'ppt-layout-card-header' },
            h('span', { className: 'ppt-layout-card-icon' }, l.icon),
            h('div', { className: 'ppt-layout-card-meta' },
              h('span', { className: 'ppt-layout-card-id' }, l.id),
              h('strong', { className: 'ppt-layout-card-name' }, l.name),
            )
          ),
          h('p', { className: 'ppt-layout-card-desc' }, l.desc),
          h('ul', { className: 'ppt-layout-card-bullets' },
            (l.bullets || []).slice(0, 2).map((b, idx) => h('li', { key: idx }, b))
          )
        ))
      ),
      h('div', { className: 'ppt-modal-footer' },
        button('取消', () => c.$layoutModalOpen.set(false)),
        button('插入标准空白正文页 (L003)', () => handleSelect(LAYOUTS[2]), false, { className: 'ppt-btn-primary' })
      )
    )
  )
}

function DocToDeckModal({ c }) {
  const open = useValue(c.$docModalOpen), busy = useValue(c.$busy)
  const [docText, setDocText] = useState('')
  const [title, setTitle] = useState('')
  const [theme, setTheme] = useState('business')
  const [targetPages, setTargetPages] = useState(8)
  const [ratio, setRatio] = useState('16:9')

  if (!open) return null

  const handleConvert = async () => {
    if (!docText.trim() || docText.trim().length < 5) {
      c.$error.set('请输入至少5个字符的文档正文或大纲内容')
      return
    }
    await c.perform('正在智能解析文档并生成 PPT…', async () => {
      const res = await c.request('/projects/from-doc', {
        method: 'POST',
        timeoutMs: 180000,
        body: {
          text: docText.trim(),
          title: title.trim() || undefined,
          target_pages: parseInt(targetPages, 10) || 8,
          theme,
          ratio,
          request_id: uid()
        }
      })
      c.$docModalOpen.set(false)
      setDocText('')
      setTitle('')
      c.accept(res.result)
    })
  }

  return h('div', { className: 'ppt-modal-backdrop', onClick: () => !busy && c.$docModalOpen.set(false) },
    h('div', { className: 'ppt-modal ppt-doc-modal', onClick: e => e.stopPropagation() },
      h('div', { className: 'ppt-modal-header' },
        h('div', null,
          h('h3', { className: 'ppt-modal-title' }, '📄 文档一键转 PPT (Doc-to-Deck)'),
          h('p', { className: 'ppt-muted', style: { margin: '2px 0 0' } }, '粘贴 Markdown、会议纪要、PRD或技术报告，AI将智能提炼并自适应匹配专业版式')
        ),
        button('✕', () => !busy && c.$docModalOpen.set(false), !!busy, { className: 'ppt-btn-icon' })
      ),
      h('div', { className: 'ppt-modal-body' },
        h('div', { className: 'ppt-form-row' },
          h('label', null, '文稿标题（选填，留空将由 AI 自动提炼）'),
          h('input', {
            className: 'ppt-input',
            placeholder: '例如：2024 年度产品战略规划与技术架构',
            value: title,
            disabled: !!busy,
            onChange: e => setTitle(e.target.value)
          })
        ),
        h('div', { className: 'ppt-form-row' },
          h('label', null, '文档正文内容或大纲 *'),
          h('textarea', {
            className: 'ppt-textarea',
            rows: 7,
            placeholder: '在此粘贴 Markdown 长文、需求文档、总结汇报或提纲…\n\n示例：\n# 核心项目复盘\n## 背景与业务痛点\n- 现有系统延迟高、资源开销大\n## 实施成果\n- 架构完成全量重构，SLA提升至99.99%',
            value: docText,
            disabled: !!busy,
            onChange: e => setDocText(e.target.value)
          })
        ),
        h('div', { className: 'ppt-form-grid' },
          h('div', { className: 'ppt-form-col' },
            h('label', null, '主题风格'),
            h('select', {
              className: 'ppt-select',
              value: theme,
              disabled: !!busy,
              onChange: e => setTheme(e.target.value)
            },
              h('option', { value: 'business' }, '💼 商务简洁 (深蓝商务)'),
              h('option', { value: 'technology' }, '⚡ 深色科技 (暗夜科技)'),
              h('option', { value: 'minimal' }, '🌿 清新极简 (雅致白灰)')
            )
          ),
          h('div', { className: 'ppt-form-col' },
            h('label', null, '目标页数'),
            h('select', {
              className: 'ppt-select',
              value: targetPages,
              disabled: !!busy,
              onChange: e => setTargetPages(Number(e.target.value))
            },
              h('option', { value: 5 }, '5 页 · 精炼极速汇报'),
              h('option', { value: 8 }, '8 页 · 标准方案讲解 (推荐)'),
              h('option', { value: 12 }, '12 页 · 深度系统性复盘'),
              h('option', { value: 16 }, '16 页 · 完整商业技术报告')
            )
          ),
          h('div', { className: 'ppt-form-col' },
            h('label', null, '画面比例'),
            h('select', {
              className: 'ppt-select',
              value: ratio,
              disabled: !!busy,
              onChange: e => setRatio(e.target.value)
            },
              h('option', { value: '16:9' }, '16:9 · 宽屏高清 (默认)'),
              h('option', { value: '4:3' }, '4:3 · 经典传统比例')
            )
          )
        )
      ),
      h('div', { className: 'ppt-modal-footer' },
        button('取消', () => c.$docModalOpen.set(false), !!busy),
        button(busy ? '正在智能转换中…' : '开始智能转换', handleConvert, !!busy || !docText.trim(), { className: 'ppt-btn-primary' })
      )
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
    doc && h('div', { className: 'ppt-nav-actions' },
      button('＋ 新增页面', () => c.$layoutModalOpen.set(true), !!c.$busy.get(), { className: 'ppt-add-slide-btn' }),
      button('📄 文档转PPT', () => c.$docModalOpen.set(true), !!c.$busy.get(), { className: 'ppt-nav-doc-btn' })
    ),
    h('div', { className: 'ppt-thumbs-list' },
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
        h('button', { className: 'ppt-suggestion-chip ppt-suggestion-primary', onClick: () => c.$docModalOpen.set(true) },
          h('span', null, '📄 文档一键转 PPT (Markdown/PRD/大纲)'),
          h('small', { className: 'ppt-muted' }, '智能萃取要点并自适应匹配10类专业版式')
        ),
        h('button', { className: 'ppt-suggestion-chip', onClick: () => c.$draft.set('生成一份 8 页的区块链技术架构与应用前景介绍。') },
          h('span', null, '🚀 生成一份 8 页的区块链技术与架构介绍'),
          h('small', { className: 'ppt-muted' }, '点击填入')
        ),
        h('button', { className: 'ppt-suggestion-chip', onClick: () => c.$draft.set('生成一份 10 页的企业商业计划书与方案。') },
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
        h('span', { className: 'ppt-stage-slide-name' }, doc.deck.slides.find(s => s.id === slideId)?.name || '当前幻灯片'),
        h('select', {
          className: 'ppt-layout-select',
          'aria-label': '页面版式',
          value: doc.deck.slides.find(s => s.id === slideId)?.layout_id || 'L003',
          onChange: event => void c.edit([{ action: 'update_slide', target: slideId, changes: { layout_id: event.target.value } }], '切换页面版式')
        },
          LAYOUTS.map(l => h('option', { key: l.id, value: l.id }, `${l.id} · ${l.name}`))
        )
      ),
      h('div', { className: 'ppt-btn-group' },
        before?.project === doc.deck.id && before?.slide === slideId && button(showingBefore ? '返回当前版本' : '查看修改前', () => c.$compare.set(!c.$compare.get())),
        showingBefore && h('span', { className: 'ppt-muted' }, `修改前 v${before.revision}`),
        button('复制本页', () => c.edit([{ action: 'duplicate_slide', target: c.$slide.get() }], '复制页面'), !!c.$busy.get()),
        button('删除本页', () => c.edit([{ action: 'delete_slide', target: c.$slide.get() }], '删除页面'), !!c.$busy.get() || doc.deck.slides.length <= 1),
        button('前移', () => { const d = c.$doc.get(); return c.edit([{ action: 'move_slide', target: c.$slide.get(), index: Math.max(0, d.deck.slides.findIndex(s => s.id === c.$slide.get()) - 1) }], '页面前移') }, !!c.$busy.get()),
        button('后移', () => { const d = c.$doc.get(); return c.edit([{ action: 'move_slide', target: c.$slide.get(), index: Math.min(d.deck.slides.length - 1, d.deck.slides.findIndex(s => s.id === c.$slide.get()) + 1) }], '页面后移') }, !!c.$busy.get())
      )
    ),
    h('div', { className: 'ppt-canvas-viewport' },
      h('div', { className: 'ppt-canvas ppt-canvas-wrapper', style: { aspectRatio: `${doc.deck.width}/${doc.deck.height}` },
        onClick: event => {
          if (showingBefore) return
          const id = event.target.closest?.('[data-element-id]')?.dataset.elementId
          const current = c.$selection.get()
          const next = id ? (event.ctrlKey || event.metaKey ? (current.includes(id) ? current.filter(v => v !== id) : [...current, id]) : [id]) : []
          c.$selection.set(next)
          if (next.length > 0) {
            c.$rightOpen.set(true)
          }
        } },
        svg ? h('div', { className: 'ppt-svg', dangerouslySetInnerHTML: { __html: svg } }) : h('p', { role: view.error ? 'alert' : 'status', style: { padding: 32 } }, view.error?.message || '正在更新预览…'),
        !showingBefore && !!boxes.length && h('svg', { className: 'ppt-selection', viewBox: `0 0 ${doc.deck.width * 72} ${doc.deck.height * 72}` },
          ...boxes.map(e => h('rect', { key: e.id, x: e.box.x * 72, y: e.box.y * 72, width: e.box.width * 72, height: e.box.height * 72, fill: 'none', stroke: 'var(--ui-accent)', strokeWidth: 2, strokeDasharray: '6 3' }))
        )
      )
    ),
    h('div', { className: 'ppt-canvas-footer' },
      h('span', { className: 'ppt-muted' }, '结构预览 · 导出保留原生对象 · 外部软件字体与排版可能有差异'),
      doc.change && h('span', { className: 'ppt-muted' }, `影响 ${doc.change.slides.length} 页、${doc.change.elements.length} 个对象`),
    ),
    ...(doc.issues || []).filter(i => i.slide_id === slideId).map((issue, i) => h('button', { key: i, className: 'ppt-issue', onClick: () => c.$selection.set([issue.element_id]) }, `${issue.element_id}：${issue.message}`)),
  )
}

function Properties({ c, expanded = false }) {
  const doc = useValue(c.$doc), selection = useValue(c.$selection), slideId = useValue(c.$slide), busy = useValue(c.$busy)
  const [search, setSearch] = useState(''), [text, setText] = useState(''), [name, setName] = useState(''), [fontSize, setFontSize] = useState(''), [masterSize, setMasterSize] = useState('32')
  const upload = useRef(null)
  const slide = doc?.deck.slides.find(s => s.id === slideId)
  const elements = doc ? [...flatten(doc.deck.master.elements).map(e => ({ ...e, source: 'M001' })), ...flatten(slide?.elements || []).map(e => ({ ...e, source: slideId }))] : []
  const chosen = selection.length === 1 ? elements.find(e => e.id === selection[0]) : null
  useEffect(() => { setText(chosen?.text || ''); setName(chosen?.name || ''); setFontSize(String(chosen?.style?.font_size || '')) }, [chosen?.id, chosen?.text, chosen?.name, chosen?.style?.font_size])
  if (!doc) return null
  return h('section', { className: `ppt-properties ppt-panel-section ${expanded ? 'ppt-panel-expanded' : ''}` },
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

function Conversation({ c, expanded = false }) {
  const doc = useValue(c.$doc), draft = useValue(c.$draft), messages = useValue(c.$messages), busy = useValue(c.$busy), error = useValue(c.$error), selection = useValue(c.$selection)
  const history = useQuery({ queryKey: ['forx-ppt', c.owner, 'history', doc?.deck.id, doc?.revision], enabled: !!doc,
    queryFn: () => c.request(`/projects/${doc.deck.id}/history`), retry: 1 })
  return h('section', { className: `ppt-chat ppt-panel-section ${expanded ? 'ppt-panel-expanded' : ''}` },
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
.forx-ppt{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--ui-bg-base);color:var(--ui-text-primary);font-size:13px;line-height:1.5;user-select:none;overflow:hidden}
.forx-ppt h3{font-size:13px;font-weight:600;margin:0}
.forx-ppt p{line-height:1.6}
.forx-ppt select{max-width:100%;border:1px solid var(--ui-stroke-secondary);border-radius:6px;padding:5px 8px;background:var(--ui-bg-base);color:var(--ui-text-primary);font-size:12px}

/* Toolbar */
.ppt-toolbar{min-height:50px;display:flex;align-items:center;flex-wrap:wrap;row-gap:6px;column-gap:8px;padding:6px 14px;background:color-mix(in srgb, var(--ui-bg-base) 85%, var(--ui-bg-elevated));border-bottom:1px solid var(--ui-stroke-secondary);backdrop-filter:blur(8px);z-index:10;flex-shrink:0}
.ppt-brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:13.5px;letter-spacing:-0.2px;color:var(--ui-text-primary);flex-shrink:0}
.ppt-brand-icon{width:26px;height:26px;border-radius:6px;background:linear-gradient(135deg, var(--ui-accent), color-mix(in srgb, var(--ui-accent) 60%, #ec4899));color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px color-mix(in srgb, var(--ui-accent) 30%, transparent)}
.ppt-doc-badge{display:flex;align-items:center;gap:7px;padding:3px 9px;border-radius:9999px;background:color-mix(in srgb, var(--ui-bg-elevated) 80%, transparent);border:1px solid var(--ui-stroke-secondary);font-size:11.5px;color:var(--ui-text-secondary);max-width:240px;flex-shrink:1;overflow:hidden}
.ppt-doc-badge .ppt-muted{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ppt-status-dot{width:7px;height:7px;border-radius:50%;background:#10b981;box-shadow:0 0 6px rgba(16,185,129,0.6);animation:ppt-pulse 2s infinite ease-in-out;flex-shrink:0}
@keyframes ppt-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(0.85)}}

.ppt-toolbar-spacer{flex:1;min-width:8px}
.ppt-btn-group{display:flex;align-items:center;background:var(--ui-bg-elevated);border:1px solid var(--ui-stroke-secondary);border-radius:8px;padding:2px;gap:2px;flex-shrink:0}
.ppt-btn-group button{border:none!important;background:transparent!important;border-radius:6px!important;padding:4px 8px!important;height:26px!important;font-size:11.5px!important}
.ppt-btn-group button:hover:not(:disabled){background:color-mix(in srgb, var(--ui-text-primary) 10%, transparent)!important}
.ppt-btn-active{color:var(--ui-accent)!important;background:color-mix(in srgb, var(--ui-accent) 15%, transparent)!important}
.ppt-theme-select{padding:4px 8px;border-radius:8px;border:1px solid var(--ui-stroke-secondary);background:var(--ui-bg-elevated);color:var(--ui-text-primary);font-size:11.5px;font-weight:500;cursor:pointer;outline:none;flex-shrink:0}
.ppt-btn-primary{background:var(--ui-accent)!important;color:#fff!important;border-radius:8px!important;font-weight:500!important;box-shadow:0 2px 8px color-mix(in srgb, var(--ui-accent) 30%, transparent)!important;border:none!important}
.ppt-btn-primary:hover:not(:disabled){filter:brightness(1.1)!important}

/* Main Flex Layout */
.ppt-layout{display:flex;flex:1;min-height:0;min-width:0;overflow:hidden;position:relative}

/* Left Sidebar - Slides Navigation */
.ppt-pages{width:200px;min-width:170px;max-width:240px;background:color-mix(in srgb, var(--ui-bg-base) 92%, var(--ui-bg-elevated));border-right:1px solid var(--ui-stroke-secondary);display:flex;flex-direction:column;padding:12px 10px;gap:10px;flex-shrink:0;overflow:hidden}
.ppt-pages-header{display:flex;align-items:center;justify-content:space-between;font-size:11.5px;font-weight:600;color:var(--ui-text-secondary);text-transform:uppercase;letter-spacing:0.5px}
.ppt-project-select{width:100%;padding:5px 8px;border-radius:6px;border:1px solid var(--ui-stroke-secondary);background:var(--ui-bg-elevated);color:var(--ui-text-primary);font-size:11.5px;cursor:pointer;outline:none}
.ppt-add-slide-btn{width:100%;border-radius:6px;border:1px dashed var(--ui-stroke-primary)!important;background:transparent!important;padding:7px!important;font-size:11.5px!important;font-weight:500!important;color:var(--ui-text-secondary)!important;display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;transition:all 0.15s ease}
.ppt-add-slide-btn:hover:not(:disabled){border-color:var(--ui-accent)!important;color:var(--ui-accent)!important;background:color-mix(in srgb, var(--ui-accent) 8%, transparent)!important}

.ppt-thumbs-list{display:flex;flex-direction:column;gap:8px;overflow-y:auto;flex:1;min-height:0;padding-right:2px}
.ppt-thumb-card{position:relative;border-radius:6px;padding:5px;background:var(--ui-bg-elevated);border:1.5px solid transparent;display:flex;flex-direction:column;gap:5px;cursor:pointer;transition:all 0.18s ease;box-shadow:0 1px 4px rgba(0,0,0,0.06);text-align:left}
.ppt-thumb-card:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,0.1);border-color:color-mix(in srgb, var(--ui-stroke-secondary) 80%, var(--ui-accent))}
.ppt-thumb-card.ppt-active{border-color:var(--ui-accent);box-shadow:0 0 0 2px color-mix(in srgb, var(--ui-accent) 25%, transparent),0 4px 14px rgba(0,0,0,0.12);background:color-mix(in srgb, var(--ui-bg-elevated) 90%, var(--ui-accent))}
.ppt-thumb-badge{position:absolute;top:8px;left:8px;background:rgba(0,0,0,0.65);color:#fff;font-size:9.5px;font-weight:700;padding:2px 5px;border-radius:4px;backdrop-filter:blur(4px);z-index:2}
.ppt-mini{aspect-ratio:16/9;border-radius:4px;overflow:hidden;background:#111;position:relative}
.ppt-mini svg{width:100%;height:100%;display:block}
.ppt-thumb-info{display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--ui-text-secondary);padding:0 2px}
.ppt-thumb-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}

/* Center Stage */
.ppt-canvas-area{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;background:radial-gradient(circle, color-mix(in srgb, var(--ui-stroke-secondary) 60%, transparent) 1px, transparent 1px);background-size:24px 24px;overflow:auto;padding:14px;gap:10px;align-items:center;justify-content:flex-start}
.ppt-stage-header{width:100%;max-width:960px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;row-gap:6px;column-gap:8px;background:color-mix(in srgb, var(--ui-bg-elevated) 85%, transparent);border:1px solid var(--ui-stroke-secondary);border-radius:8px;padding:6px 12px;backdrop-filter:blur(8px);flex-shrink:0}
.ppt-stage-title{font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:6px;min-width:0}
.ppt-stage-slide-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px}
.ppt-canvas-viewport{width:100%;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:4px 0}
.ppt-canvas-wrapper{position:relative;width:min(100%, calc((100vh - 200px) * 16 / 9));max-width:960px;box-shadow:0 16px 40px -10px rgba(0,0,0,0.35),0 0 0 1px var(--ui-stroke-secondary);border-radius:8px;overflow:hidden;background:#ffffff;flex-shrink:0;margin:auto 0}
.ppt-svg{position:absolute;inset:0;width:100%;height:100%}
.ppt-selection{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.ppt-canvas-footer{display:flex;align-items:center;gap:12px;font-size:11px;color:var(--ui-text-tertiary);flex-shrink:0}

/* Empty State Hero */
.ppt-empty-hero{max-width:540px;margin:auto;text-align:center;padding:36px 24px;background:color-mix(in srgb, var(--ui-bg-elevated) 90%, transparent);border:1px solid var(--ui-stroke-secondary);border-radius:14px;box-shadow:0 12px 36px rgba(0,0,0,0.1);display:flex;flex-direction:column;align-items:center;gap:12px}
.ppt-empty-icon{width:52px;height:52px;border-radius:12px;background:linear-gradient(135deg, color-mix(in srgb, var(--ui-accent) 25%, transparent), color-mix(in srgb, #8b5cf6 25%, transparent));color:var(--ui-accent);display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px color-mix(in srgb, var(--ui-accent) 20%, transparent)}
.ppt-empty-hero h2{font-size:17px;font-weight:700;margin:0;color:var(--ui-text-primary);letter-spacing:-0.2px}
.ppt-empty-hero p{color:var(--ui-text-secondary);margin:0;font-size:12px;max-width:420px;line-height:1.6}
.ppt-suggestion-grid{display:flex;flex-direction:column;gap:7px;width:100%;margin-top:6px}
.ppt-suggestion-chip{text-align:left;padding:8px 12px;border-radius:7px;background:color-mix(in srgb, var(--ui-bg-base) 70%, var(--ui-bg-elevated));border:1px solid var(--ui-stroke-secondary);font-size:11.5px;color:var(--ui-text-primary);display:flex;align-items:center;justify-content:space-between;cursor:pointer;transition:all 0.15s ease}
.ppt-suggestion-chip:hover{border-color:var(--ui-accent);background:color-mix(in srgb, var(--ui-accent) 10%, transparent);transform:translateX(2px)}

/* Right Sidebar */
.ppt-side{width:330px;min-width:290px;max-width:400px;background:color-mix(in srgb, var(--ui-bg-base) 94%, var(--ui-bg-elevated));border-left:1px solid var(--ui-stroke-secondary);display:flex;flex-direction:column;overflow-y:auto;min-height:0;flex-shrink:0}
.ppt-side-tabs{display:flex;background:var(--ui-bg-elevated);border-bottom:1px solid var(--ui-stroke-secondary);padding:4px;gap:4px;flex-shrink:0}
.ppt-side-tab{flex:1;padding:5px 8px;border-radius:6px;border:none;background:transparent;color:var(--ui-text-secondary);font-size:11.5px;font-weight:500;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px;transition:all 0.15s ease}
.ppt-side-tab:hover{color:var(--ui-text-primary);background:color-mix(in srgb, var(--ui-text-primary) 6%, transparent)}
.ppt-side-tab.ppt-side-tab-active{color:var(--ui-accent);background:color-mix(in srgb, var(--ui-accent) 12%, transparent);font-weight:600}
.ppt-tab-dot{width:6px;height:6px;border-radius:50%;background:var(--ui-accent)}

.ppt-panel-section{padding:12px;display:flex;flex-direction:column;gap:10px;border-bottom:1px solid var(--ui-stroke-secondary)}
.ppt-panel-expanded{flex:1;min-height:0;display:flex;flex-direction:column;border-bottom:none}
.ppt-panel-expanded .ppt-messages-box{flex:1;max-height:none!important}
.ppt-panel-expanded .ppt-element-chips{max-height:220px}
.ppt-panel-expanded .ppt-chat-input-box{margin-top:auto}

.ppt-panel-header{display:flex;align-items:center;justify-content:space-between;font-size:12.5px;font-weight:600;color:var(--ui-text-primary)}
.ppt-pill-badge{font-size:10px;padding:2px 7px;border-radius:9999px;background:color-mix(in srgb, var(--ui-accent) 15%, transparent);color:var(--ui-accent);font-weight:600}

/* Chat Section */
.ppt-messages-box{min-height:80px;max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:2px}
.ppt-msg-bubble{padding:8px 11px;border-radius:9px;font-size:12px;line-height:1.55;max-width:92%;word-break:break-word}
.ppt-msg-user{align-self:flex-end;background:color-mix(in srgb, var(--ui-accent) 18%, transparent);border:1px solid color-mix(in srgb, var(--ui-accent) 30%, transparent);color:var(--ui-text-primary);border-bottom-right-radius:2px}
.ppt-msg-assistant{align-self:flex-start;background:var(--ui-bg-elevated);border:1px solid var(--ui-stroke-secondary);color:var(--ui-text-primary);border-bottom-left-radius:2px}
.ppt-chat-input-box{border:1px solid var(--ui-stroke-secondary);border-radius:9px;background:var(--ui-bg-elevated);padding:8px;display:flex;flex-direction:column;gap:7px;transition:border-color 0.15s ease,box-shadow 0.15s ease}
.ppt-chat-input-box:focus-within{border-color:var(--ui-accent);box-shadow:0 0 0 2px color-mix(in srgb, var(--ui-accent) 20%, transparent)}
.ppt-chat-input-box textarea{border:none!important;background:transparent!important;padding:0!important;box-shadow:none!important;resize:none;font-size:12px;line-height:1.5;outline:none!important}
.ppt-input-footer{display:flex;align-items:center;justify-content:space-between;padding-top:4px;border-top:1px solid color-mix(in srgb, var(--ui-stroke-secondary) 50%, transparent)}

/* Properties */
.ppt-element-chips{display:flex;flex-wrap:wrap;gap:5px;max-height:120px;overflow-y:auto;padding:2px}
.ppt-elem-chip{padding:3px 7px;border-radius:5px;border:1px solid var(--ui-stroke-secondary);background:var(--ui-bg-elevated);color:var(--ui-text-secondary);font-size:11px;cursor:pointer;display:flex;align-items:center;gap:4px;transition:all 0.12s ease}
.ppt-elem-chip:hover{border-color:var(--ui-stroke-primary);color:var(--ui-text-primary)}
.ppt-elem-chip.ppt-active{border-color:var(--ui-accent);background:color-mix(in srgb, var(--ui-accent) 15%, transparent);color:var(--ui-accent);font-weight:500}
.ppt-inspector-card{background:var(--ui-bg-elevated);border:1px solid var(--ui-stroke-secondary);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px}
.ppt-form-row{display:flex;flex-direction:column;gap:5px}
.ppt-field-label{display:flex;flex-direction:column;gap:4px;font-size:11px;font-weight:500;color:var(--ui-text-secondary);width:100%}

.ppt-muted{color:var(--ui-text-tertiary);font-size:11px}
.ppt-error,.ppt-issue{color:var(--ui-text-primary);background:color-mix(in srgb, #ef4444 12%, transparent);border:1px solid color-mix(in srgb, #ef4444 35%, transparent);border-radius:8px;padding:8px 12px;text-align:left;font-size:12px;margin:0}
.ppt-connecting{padding:40px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:16px;max-width:480px;margin:auto}

/* Navigation action buttons */
.ppt-nav-actions{display:flex;flex-direction:column;gap:5px}
.ppt-nav-doc-btn{width:100%;padding:6px;border-radius:6px;border:1px dashed var(--ui-stroke-secondary);background:transparent;color:var(--ui-text-secondary);font-size:11.5px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px;transition:all 0.15s ease}
.ppt-nav-doc-btn:hover{color:var(--ui-accent);border-color:var(--ui-accent);background:color-mix(in srgb, var(--ui-accent) 8%, transparent)}

/* Stage Layout Selector */
.ppt-layout-select{margin-left:6px;padding:2px 6px;font-size:11px;font-weight:500;border-radius:6px;border:1px solid var(--ui-stroke-secondary);background:var(--ui-bg-elevated);color:var(--ui-text-primary);cursor:pointer}
.ppt-layout-select:focus{border-color:var(--ui-accent);outline:none}

/* Modals */
.ppt-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px}
.ppt-modal{background:var(--ui-bg-base);border:1px solid var(--ui-stroke-secondary);border-radius:14px;box-shadow:0 16px 40px rgba(0,0,0,0.3);display:flex;flex-direction:column;overflow:hidden;animation:ppt-pop 0.18s ease-out;max-height:90vh}
@keyframes ppt-pop{0%{opacity:0;transform:scale(0.96)}100%{opacity:1;transform:scale(1)}}
.ppt-modal-header{display:flex;align-items:flex-start;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--ui-stroke-secondary);background:var(--ui-bg-elevated)}
.ppt-modal-title{font-size:15px;font-weight:700;color:var(--ui-text-primary);margin:0}
.ppt-btn-icon{border:none;background:transparent;color:var(--ui-text-secondary);cursor:pointer;font-size:16px;padding:4px 8px;border-radius:6px}
.ppt-btn-icon:hover{background:var(--ui-bg-base);color:var(--ui-text-primary)}
.ppt-modal-body{padding:18px 20px;display:flex;flex-direction:column;gap:14px;overflow-y:auto}
.ppt-modal-footer{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:14px 20px;border-top:1px solid var(--ui-stroke-secondary);background:var(--ui-bg-elevated)}

/* Layout Picker Modal */
.ppt-layout-modal{width:860px;max-width:96vw}
.ppt-layout-grid{display:grid;grid-template-columns:repeat(auto-fill, minmax(240px, 1fr));gap:10px;padding:18px 20px;overflow-y:auto;max-height:60vh}
.ppt-layout-card{background:var(--ui-bg-elevated);border:1px solid var(--ui-stroke-secondary);border-radius:10px;padding:12px;cursor:pointer;display:flex;flex-direction:column;gap:6px;transition:all 0.15s ease}
.ppt-layout-card:hover{border-color:var(--ui-accent);transform:translateY(-1px);box-shadow:0 6px 16px color-mix(in srgb, var(--ui-accent) 15%, transparent)}
.ppt-layout-card-header{display:flex;align-items:center;gap:8px}
.ppt-layout-card-icon{font-size:20px;display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;background:color-mix(in srgb, var(--ui-accent) 12%, transparent)}
.ppt-layout-card-meta{display:flex;flex-direction:column}
.ppt-layout-card-id{font-size:10px;font-weight:600;color:var(--ui-accent)}
.ppt-layout-card-name{font-size:12.5px;color:var(--ui-text-primary)}
.ppt-layout-card-desc{font-size:11px;color:var(--ui-text-secondary);margin:0;line-height:1.4}
.ppt-layout-card-bullets{margin:4px 0 0;padding-left:16px;font-size:10.5px;color:var(--ui-text-tertiary);line-height:1.4}

/* Doc to Deck Modal */
.ppt-doc-modal{width:700px;max-width:94vw}
.ppt-input,.ppt-textarea,.ppt-select{width:100%;border:1px solid var(--ui-stroke-secondary);border-radius:7px;padding:8px 10px;background:var(--ui-bg-elevated);color:var(--ui-text-primary);font-size:12.5px;box-sizing:border-box;transition:border-color 0.15s ease}
.ppt-input:focus,.ppt-textarea:focus,.ppt-select:focus{border-color:var(--ui-accent);outline:none}
.ppt-textarea{resize:vertical;font-family:inherit;line-height:1.55}
.ppt-form-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.ppt-form-col{display:flex;flex-direction:column;gap:5px}
.ppt-form-col label,.ppt-form-row label{font-size:11.5px;font-weight:600;color:var(--ui-text-secondary)}
.ppt-suggestion-primary{border-color:color-mix(in srgb, var(--ui-accent) 40%, transparent)!important;background:color-mix(in srgb, var(--ui-accent) 10%, transparent)!important}

@media(max-width:1000px){
  .ppt-pages{width:170px;min-width:150px}
  .ppt-side{width:290px;min-width:260px}
}
`

function Workbench({ c }) {
  const doc = useValue(c.$doc), busy = useValue(c.$busy), gateway = useValue(host.state.gateway)
  const leftOpen = useValue(c.$leftOpen), rightOpen = useValue(c.$rightOpen), panelTab = useValue(c.$panelTab)
  const selection = useValue(c.$selection)
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
      leftOpen && h(Navigation, { c }),
      h(Canvas, { c }),
      rightOpen && h('aside', { className: 'ppt-side' },
        doc && h('div', { className: 'ppt-side-tabs' },
          h('button', { className: `ppt-side-tab ${panelTab === 'all' ? 'ppt-side-tab-active' : ''}`, onClick: () => c.$panelTab.set('all') }, '全部'),
          h('button', { className: `ppt-side-tab ${panelTab === 'chat' ? 'ppt-side-tab-active' : ''}`, onClick: () => c.$panelTab.set('chat') }, '✨ AI 对话'),
          h('button', { className: `ppt-side-tab ${panelTab === 'properties' ? 'ppt-side-tab-active' : ''}`, onClick: () => c.$panelTab.set('properties') },
            '🎨 元素设计',
            selection.length ? h('span', { className: 'ppt-tab-dot' }) : null
          ),
        ),
        (panelTab === 'all' || panelTab === 'chat') && h(Conversation, { c, expanded: panelTab === 'chat' }),
        (panelTab === 'all' || panelTab === 'properties') && h(Properties, { c, expanded: panelTab === 'properties' })
      )
    ),
    h(LayoutPickerModal, { c }),
    h(DocToDeckModal, { c })
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

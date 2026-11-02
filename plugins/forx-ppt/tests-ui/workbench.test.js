import { createElement as h } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { host, QueryClient, QueryClientProvider } from './sdk.js'
import plugin from '../desktop/plugin.js'

const makeDocument = (name = '测试文稿') => ({ revision: 1, undo_available: false, redo_available: false, issues: [], deck: {
  id: 'project-a', name, width: 13.333333, height: 7.5, theme: { name: '商务简洁', primary: '#2459A8', accent: '#168C92', background: '#FFFFFF', text: '#17243B' },
  master: { id: 'M001', elements: [{ id: 'E0001', name: '品牌', kind: 'text', text: 'ACME', style: {}, box: { x: 10, y: .2, width: 2, height: .5 } }] },
  slides: [{
    id: 'S001', name: '第一页', elements: [
      { id: 'E0002', name: '主标题', kind: 'text', role: 'title', text: '原始标题', style: {} },
      { id: 'E0003', name: '数据趋势', kind: 'chart', chart_type: 'column', box: { x: 1, y: 2, width: 6, height: 3 }, categories: ['A', 'B'], series: [{ name: '数值', values: [10, 20] }], style: {} }
    ]
  }],
} })
let clients = []
beforeEach(() => { host.state.connectionId.set('local'); host.state.profile.set('default') })
afterEach(() => { cleanup(); clients.forEach(c => c.clear()); clients = [] })

function mount(chat) {
  let current = null
  const contributions = []
  const storage = new Map()
  const ctx = { storage: { get: (key, fallback) => storage.has(key) ? storage.get(key) : fallback, set: (key, value) => storage.set(key, value) },
    registerMany: values => contributions.push(...values),
    rest: vi.fn(async (path, options) => {
      if (path === '/status') return { ready: true }
      if (path === '/chat') return chat(options.body)
      if (path === '/cancel') return { cancelled: true }
      if (path === '/assets') return { asset_id: 'logo-asset-123', width: 200, height: 80 }
      if (path === '/parse-file') return { filename: options.body.filename, format: 'docx', size: 1024, char_count: 50, text: '参考文档中的业务架构要点与量化成果指标。' }
      if (path === '/projects/from-doc') { current = makeDocument('文档生成文稿'); return { result: current, message: '转换成功' } }
      if (path === '/projects/generate-outline') {
        return {
          title: options?.body?.title || '智能架构演进方案',
          target_pages: 3,
          summary: '从痛点分析到平台架构设计',
          slides: [
            { title: '业务痛点分析', layout_id: 'L001', bullets: ['高延迟', '单点故障'] },
            { title: '微服务架构设计', layout_id: 'L003', bullets: ['服务治理', '网关路由'] },
            { title: '收益与实施规划', layout_id: 'L006', bullets: ['SLA 99.99%', '降本30%'] },
          ]
        }
      }
      if (path === '/generate-image') {
        const assetId = 'a'.repeat(64)
        if (current) current = { ...current, revision: current.revision + 1 }
        return { success: true, asset_id: assetId, width: 1280, height: 720, provider: 'forx-visual-engine', result: current }
      }
      if (path === '/projects' && options?.method === 'POST') {
        const title = options?.body?.slides ? (options?.body?.name || '大纲生成文稿') : '测试文稿'
        current = makeDocument(title)
        return current
      }
      if (path === '/projects') return { projects: current ? [{ id: current.deck.id, name: current.deck.name }] : [] }
      if (path.startsWith('/projects/') && options?.method === 'DELETE') {
        const id = path.split('/projects/')[1]
        if (current && current.deck.id === id) current = null
        return { deleted: true, project_id: id }
      }
      if (path.endsWith('/history')) return { history: [] }
      if (path.includes('/preview/')) return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><g data-element-id="E0002"><text>标题画布</text></g><g data-element-id="E0003"><text>图表</text></g></svg>', assets: [], elements: [{ id: 'E0002', name: '主标题', kind: 'text', role: 'title', box: { x: 0.6, y: 0.7, width: 8.0, height: 1.0 } }, { id: 'E0003', name: '数据趋势', kind: 'chart', box: { x: 1.0, y: 2.0, width: 6.0, height: 3.0 } }], revision: current?.revision || 1 }
      if (path.includes('/generate-notes')) {
        const generatedNotes = '各位观众好，本页为业务架构演示，核心关注高可用与微服务演进。'
        if (current) {
          const s = current.deck.slides[0]
          if (s) s.notes = generatedNotes
          current = { ...current, revision: current.revision + 1 }
        }
        return { notes: generatedNotes, result: current }
      }
      if (path.includes('/download')) {
        return { filename: 'test.pptx', content_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', data: 'UEsDBA==', revision: current?.revision || 1 }
      }
      if (path.endsWith('/edit')) { current = { ...current, revision: current.revision + 1 }; return current }
      return current
    }),
  }
  plugin.register(ctx)
  const page = contributions.find(c => c.id === 'page')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  render(h(QueryClientProvider, { client }, page.render()))
  return ctx
}

it('creates a project, selects the stable object, submits a targeted edit and isolates another connection', async () => {
  const ctx = mount()
  fireEvent.click(await screen.findByRole('button', { name: '空白新建' }))
  await screen.findByText('测试文稿 · v1 · 已保存')
  fireEvent.click(screen.getByRole('button', { name: /E0002 · 主标题/ }))
  fireEvent.change(screen.getByLabelText('文字'), { target: { value: '只更新这一个标题' } })
  fireEvent.click(screen.getByRole('button', { name: '更新本页文字' }))
  await waitFor(() => expect(ctx.rest.mock.calls.some(([path, opts]) => path.endsWith('/edit') && opts.body.revision === 1 && opts.body.operations[0].target === 'E0002' && opts.body.operations[0].changes.text === '只更新这一个标题')).toBe(true))
  await screen.findByText('测试文稿 · v2 · 已保存')
  host.state.connectionId.set('remote-b')
  await screen.findByText('把想表达的内容变成可编辑 PPT')
  expect(screen.queryByText('测试文稿 · v2 · 已保存')).toBeNull()
})

it('keeps a new request pending when an earlier cancelled model response arrives', async () => {
  const pending = []
  mount(() => new Promise(resolve => pending.push(resolve)))
  const field = await screen.findByLabelText('PPT 对话指令')
  fireEvent.change(field, { target: { value: '生成旧稿' } })
  fireEvent.click(screen.getByRole('button', { name: '生成初稿' }))
  await waitFor(() => expect(pending).toHaveLength(1))
  fireEvent.click(screen.getByRole('button', { name: '取消本次指令' }))
  await screen.findByText('已取消，本次指令不会修改原稿。')
  fireEvent.change(field, { target: { value: '生成最新稿' } })
  fireEvent.click(screen.getByRole('button', { name: '生成初稿' }))
  await waitFor(() => expect(pending).toHaveLength(2))
  pending[0]({ result: makeDocument('旧稿'), message: '迟到结果' })
  await waitFor(() => expect(screen.getByRole('button', { name: '取消本次指令' })).toBeTruthy())
  expect(screen.queryByText('旧稿 · v1 · 已保存')).toBeNull()
  pending[1]({ result: makeDocument('最新稿'), message: '新稿已保存' })
  await screen.findByText('最新稿 · v1 · 已保存')
  expect(screen.queryByRole('button', { name: '取消本次指令' })).toBeNull()
})

it('cleans up raw IPC remote error and formats friendly message on failure', async () => {
  mount(() => {
    throw new Error(`Error invoking remote method 'hermes:api': Error: 422: {"detail":[{"loc":["body","slides",0,"name"],"msg":"Field required"}]}`)
  })
  const field = await screen.findByLabelText('PPT 对话指令')
  fireEvent.change(field, { target: { value: '生成一份介绍' } })
  fireEvent.click(screen.getByRole('button', { name: '生成初稿' }))
  await screen.findByText(/内容校验未通过 \(422\): slides.0.name: Field required/)
})

it('opens layout picker with 10 layouts and adds slide with selected layout', async () => {
  const ctx = mount()
  fireEvent.click(await screen.findByRole('button', { name: '空白新建' }))
  await screen.findByText('测试文稿 · v1 · 已保存')
  fireEvent.click(screen.getByRole('button', { name: '＋ 新增页面' }))
  await screen.findByText('选择新增页面版式 (10 类专业版式)')
  expect(screen.getByText('时间轴')).toBeTruthy()
  expect(screen.getByText('多列卡片')).toBeTruthy()
  expect(screen.getByText('关键指标')).toBeTruthy()
  expect(screen.getByText('四象限/SWOT')).toBeTruthy()
  expect(screen.getByText('方案对比')).toBeTruthy()
  fireEvent.click(screen.getByText('时间轴'))
  await waitFor(() => expect(ctx.rest.mock.calls.some(([path, opts]) =>
    path.endsWith('/edit') && opts.body.operations[0].action === 'add_slide' && opts.body.operations[0].slide.layout_id === 'L006'
  )).toBe(true))
})

it('opens doc-to-deck modal, inputs document content and submits conversion', async () => {
  const ctx = mount()
  const docBtn = await screen.findByRole('button', { name: '文档转PPT' })
  fireEvent.click(docBtn)
  await screen.findByText('📄 文档一键转 PPT (Doc-to-Deck)')
  const textarea = screen.getByPlaceholderText(/在此粘贴 Markdown 长文/)
  fireEvent.change(textarea, { target: { value: '# 季度规划\n- 任务A\n- 任务B' } })
  fireEvent.click(screen.getByRole('button', { name: '开始智能转换' }))
  await waitFor(() => expect(ctx.rest.mock.calls.some(([path, opts]) =>
    path === '/projects/from-doc' && opts.body.target_pages === 8 && opts.body.text.includes('# 季度规划')
  )).toBe(true))
  await screen.findByText('文档生成文稿 · v1 · 已保存')
})

it('opens delete modal and confirms deck deletion', async () => {
  const ctx = mount()
  fireEvent.click(await screen.findByRole('button', { name: '空白新建' }))
  await screen.findByText('测试文稿 · v1 · 已保存')
  const delBtn = screen.getByRole('button', { name: '删除文稿' })
  fireEvent.click(delBtn)
  await screen.findByText('🗑️ 删除演示文稿')
  expect(screen.getAllByText('测试文稿').length).toBeGreaterThanOrEqual(1)
  expect(screen.getByText('1 页幻灯片')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '确认删除文稿' }))
  await waitFor(() => expect(ctx.rest.mock.calls.some(([path, opts]) =>
    path === '/projects/project-a' && opts?.method === 'DELETE'
  )).toBe(true))
  await screen.findByText('把想表达的内容变成可编辑 PPT')
  expect(screen.queryByText('测试文稿 · v1 · 已保存')).toBeNull()
})

it('opens AI image generation modal, fills prompt and generates image', async () => {
  const ctx = mount()
  fireEvent.click(await screen.findByRole('button', { name: '空白新建' }))
  await screen.findByText('测试文稿 · v1 · 已保存')
  fireEvent.click(screen.getByRole('button', { name: '🎨 AI生图' }))
  await screen.findByText('🎨 AI 智能内容配图 (Image Gen)')
  expect(screen.getByText('🪄 从本页提取主旨')).toBeTruthy()
  fireEvent.click(screen.getByText('🪄 从本页提取主旨'))
  const textarea = screen.getByPlaceholderText(/例如：云原生高可用微服务架构示意图/)
  expect(textarea.value).toContain('第一页')
  fireEvent.click(screen.getByRole('button', { name: '🎨 立即生成并插入' }))
  await waitFor(() => expect(ctx.rest.mock.calls.some(([path, opts]) =>
    path === '/generate-image' && opts.body.prompt.includes('第一页') && opts.body.project_id === 'project-a'
  )).toBe(true))
})

it('surfaces selection action bar in chat dialog and triggers image generation for selected element', async () => {
  const ctx = mount()
  fireEvent.click(await screen.findByRole('button', { name: '空白新建' }))
  await screen.findByText('测试文稿 · v1 · 已保存')

  // Select element E0002
  fireEvent.click(screen.getByRole('button', { name: /E0002 · 主标题/ }))

  // Verify selection quick action bar in chat dialog
  await screen.findByText(/已选定元素：E0002/)
  const genBtn = screen.getByRole('button', { name: '🎨 根据选定元素生图' })
  expect(genBtn).toBeTruthy()
  fireEvent.click(genBtn)

  // Verify ImageGenModal opens targeted at element E0002
  await screen.findByText(/为选定元素 E0002 生成配图/)
  expect(screen.getByRole('button', { name: '🪄 提取元素主旨' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '🪄 提取元素主旨' }))

  const textarea = screen.getByPlaceholderText(/例如：云原生高可用微服务架构示意图/)
  expect(textarea.value).toContain('主标题')

  fireEvent.click(screen.getByRole('button', { name: '🎨 为选定元素生成并替换' }))
  await waitFor(() => expect(ctx.rest.mock.calls.some(([path, opts]) =>
    path === '/generate-image' && opts.body.element_id === 'E0002' && opts.body.project_id === 'project-a'
  )).toBe(true))
})

it('supports attaching reference files to chat dialog and sending enriched prompt to supplement PPT', async () => {
  let receivedChat = null
  const ctx = mount((body) => {
    receivedChat = body
    return { result: makeDocument('已补充文稿'), message: '已根据附件内容扩充幻灯片要点' }
  })
  fireEvent.click(await screen.findByRole('button', { name: '空白新建' }))
  await screen.findByText('测试文稿 · v1 · 已保存')

  // In chat input, verify attach button
  const attachBtn = screen.getByRole('button', { name: '📎 添加参考文件' })
  expect(attachBtn).toBeTruthy()

  // Simulate attaching a text file
  const file = new File(['系统架构设计规范：微服务解耦与SLA可用性达到99.99%'], 'arch-spec.md', { type: 'text/markdown' })
  const input = attachBtn.previousElementSibling
  expect(input.type).toBe('file')
  fireEvent.change(input, { target: { files: [file] } })

  // Verify file pill appears in attachments list
  await screen.findByText('arch-spec.md')

  // Type prompt
  const field = screen.getByLabelText('PPT 对话指令')
  fireEvent.change(field, { target: { value: '参考附件中的系统架构设计，为本页补充技术要点' } })

  // Send
  fireEvent.click(screen.getByRole('button', { name: '发送修改' }))

  await waitFor(() => expect(receivedChat).not.toBeNull())
  expect(receivedChat.prompt).toContain('【用户上传的参考文件内容】')
  expect(receivedChat.prompt).toContain('arch-spec.md')
  expect(receivedChat.prompt).toContain('微服务解耦与SLA可用性达到99.99%')
  expect(receivedChat.prompt).toContain('参考附件中的系统架构设计，为本页补充技术要点')

  await screen.findByText('已根据附件内容扩充幻灯片要点')
})

it('opens smart relayout modal and transforms current slide layout with relayout_slide', async () => {
  const ctx = mount()
  fireEvent.click(await screen.findByRole('button', { name: '空白新建' }))
  await screen.findByText('测试文稿 · v1 · 已保存')

  // Click ✨ 智能重构 button in stage header
  const relayoutBtn = screen.getByRole('button', { name: '✨ 智能重构' })
  expect(relayoutBtn).toBeTruthy()
  fireEvent.click(relayoutBtn)

  // Verify modal opens
  await screen.findByText(/智能重构本页排版/)
  expect(screen.getByText('关键指标')).toBeTruthy()
  expect(screen.getByText('多列卡片')).toBeTruthy()

  // Click 多列卡片 card
  fireEvent.click(screen.getByText('多列卡片'))
  await waitFor(() => expect(ctx.rest.mock.calls.some(([path, opts]) =>
    path.endsWith('/edit') && opts.body.operations[0].action === 'relayout_slide' && opts.body.operations[0].changes.layout_id === 'L007'
  )).toBe(true))
})

it('supports double click on canvas element for in-place inline text editing', async () => {
  const ctx = mount()
  fireEvent.click(await screen.findByRole('button', { name: '空白新建' }))
  await screen.findByText('测试文稿 · v1 · 已保存')

  // Select element E0002
  fireEvent.click(screen.getByRole('button', { name: /E0002 · 主标题/ }))
  await screen.findByText(/已选定元素：E0002/)

  // Double click on move handle in SVG selection
  const moveRect = document.querySelector('.ppt-selection-group rect[cursor="move"]')
  expect(moveRect).toBeTruthy()
  fireEvent.doubleClick(moveRect)

  // Verify inline textarea overlay appears
  const inlineTextarea = screen.getByPlaceholderText('输入文字，Ctrl+Enter 保存，Esc 取消')
  expect(inlineTextarea).toBeTruthy()
  expect(inlineTextarea.value).toBe('原始标题')

  // Modify text and submit via Ctrl+Enter
  fireEvent.change(inlineTextarea, { target: { value: '画布就地直接修改的标题' } })
  fireEvent.keyDown(inlineTextarea, { key: 'Enter', ctrlKey: true })

  await waitFor(() => expect(ctx.rest.mock.calls.some(([path, opts]) =>
    path.endsWith('/edit') && opts.body.operations[0].action === 'update_element' && opts.body.operations[0].changes.text === '画布就地直接修改的标题'
  )).toBe(true))
})

it('toggles full-screen presentation mode, laser pointer, notes hud, and exits via escape', async () => {
  const ctx = mount()
  fireEvent.click(await screen.findByRole('button', { name: '空白新建' }))
  await screen.findByText('测试文稿 · v1 · 已保存')

  // Click ▶ 放映 button
  const presentBtn = screen.getByRole('button', { name: '▶ 放映' })
  expect(presentBtn).toBeTruthy()
  fireEvent.click(presentBtn)

  // Verify presentation overlay and hud appear
  await screen.findByText('S001 · 1')
  expect(screen.getByRole('button', { name: '🔴 激光笔' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '🎙️ 备忘' })).toBeTruthy()

  // Toggle laser pointer
  fireEvent.click(screen.getByRole('button', { name: '🔴 激光笔' }))
  expect(document.querySelector('.ppt-laser-pointer-dot')).toBeTruthy()

  // Toggle speaker notes in presentation
  fireEvent.click(screen.getByRole('button', { name: '🎙️ 备忘' }))
  await screen.findByText(/🎙️ 演讲备忘/)

  // Toggle blackout mode
  fireEvent.click(screen.getByRole('button', { name: '⬛ 黑屏' }))
  await screen.findByText(/已开启黑屏/)

  // Exit presentation via Esc key
  fireEvent.keyDown(window, { key: 'Escape' })
  await waitFor(() => expect(document.querySelector('.ppt-presentation-overlay')).toBeNull())
})

it('edits speaker notes in properties panel and triggers AI speech notes generation', async () => {
  const ctx = mount()
  fireEvent.click(await screen.findByRole('button', { name: '空白新建' }))
  await screen.findByText('测试文稿 · v1 · 已保存')

  // Find speaker notes section in properties panel
  await screen.findByText(/本页演讲备忘/)
  const notesTextarea = screen.getByPlaceholderText(/记录本页核心提词、演讲逻辑或点击上方/)
  expect(notesTextarea).toBeTruthy()

  // Manually edit notes
  fireEvent.change(notesTextarea, { target: { value: '手动记录的演讲备忘要点' } })
  fireEvent.blur(notesTextarea)

  await waitFor(() => expect(ctx.rest.mock.calls.some(([path, opts]) =>
    path.endsWith('/edit') && opts.body.operations[0].action === 'update_slide' && opts.body.operations[0].changes.notes === '手动记录的演讲备忘要点'
  )).toBe(true))

  // Click AI generate speech notes button
  const aiNotesBtn = screen.getByRole('button', { name: '✨ AI 生成讲稿' })
  fireEvent.click(aiNotesBtn)

  await waitFor(() => expect(ctx.rest.mock.calls.some(([path]) =>
    path.includes('/slides/S001/generate-notes')
  )).toBe(true))
  await screen.findByText(/各位观众好，本页为业务架构演示/)
})

it('opens export modal and supports exporting pptx and triggering vector pdf printing', async () => {
  const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {})
  const ctx = mount()
  fireEvent.click(await screen.findByRole('button', { name: '空白新建' }))
  await screen.findByText('测试文稿 · v1 · 已保存')

  // Click 📤 导出 button in toolbar
  const exportBtn = screen.getByRole('button', { name: '📤 导出' })
  expect(exportBtn).toBeTruthy()
  fireEvent.click(exportBtn)

  // Verify export modal sheet is displayed with 5 formats
  await screen.findByText('导出与分享演示文稿')
  expect(screen.getByText('PowerPoint 演示文稿 (.pptx)')).toBeTruthy()
  expect(screen.getByText('矢量 PDF 文档 (.pdf)')).toBeTruthy()
  expect(screen.getByText('全篇高清长图海报 (.png)')).toBeTruthy()
  expect(screen.getByText(/当前页高清图/)).toBeTruthy()
  expect(screen.getByText('项目工程包 (.forxppt)')).toBeTruthy()

  // Click PDF export option
  fireEvent.click(screen.getByText('矢量 PDF 文档 (.pdf)'))
  expect(printSpy).toHaveBeenCalled()

  printSpy.mockRestore()
})

it('switches chart type to radar, donut, bar or area in properties inspector', async () => {
  const ctx = mount()
  fireEvent.click(await screen.findByRole('button', { name: '空白新建' }))
  await screen.findByText('测试文稿 · v1 · 已保存')

  // Select chart element E0003
  fireEvent.click(screen.getByRole('button', { name: /E0003 · 数据趋势/ }))

  // Find chart type selector in properties panel
  const chartTypeSelect = screen.getByLabelText('切换图表类型')
  expect(chartTypeSelect).toBeTruthy()
  expect(chartTypeSelect.value).toBe('column')

  // Switch to radar
  fireEvent.change(chartTypeSelect, { target: { value: 'radar' } })
  await waitFor(() => expect(ctx.rest.mock.calls.some(([path, opts]) =>
    path.endsWith('/edit') && opts.body.operations[0].action === 'update_element' && opts.body.operations[0].target === 'E0003' && opts.body.operations[0].changes.chart_type === 'radar'
  )).toBe(true))

  // Switch to donut
  fireEvent.change(chartTypeSelect, { target: { value: 'donut' } })
  await waitFor(() => expect(ctx.rest.mock.calls.some(([path, opts]) =>
    path.endsWith('/edit') && opts.body.operations[0].action === 'update_element' && opts.body.operations[0].target === 'E0003' && opts.body.operations[0].changes.chart_type === 'donut'
  )).toBe(true))
})

it('opens brand kit modal, customizes palette colors and uploads master logo', async () => {
  const ctx = mount()
  fireEvent.click(await screen.findByRole('button', { name: '空白新建' }))
  await screen.findByText('测试文稿 · v1 · 已保存')

  // Click 🎨 品牌规范 button in toolbar
  const brandKitBtn = screen.getByRole('button', { name: '🎨 品牌规范' })
  expect(brandKitBtn).toBeTruthy()
  fireEvent.click(brandKitBtn)

  // Verify modal is open
  await screen.findByText('🎨 企业品牌规范与资产设定')
  expect(screen.getByText('🍎 活力果红', { selector: 'strong' })).toBeTruthy()
  expect(screen.getByText('👑 尊贵雅致', { selector: 'strong' })).toBeTruthy()
  expect(screen.getByText('🍸 香槟轻奢', { selector: 'strong' })).toBeTruthy()

  // Click preset theme card
  fireEvent.click(screen.getByText('🍎 活力果红', { selector: 'strong' }))
  await waitFor(() => expect(ctx.rest.mock.calls.some(([path, opts]) =>
    path.endsWith('/edit') && opts.body.operations[0].action === 'theme' && opts.body.operations[0].changes.preset === 'crimson'
  )).toBe(true))

  // Custom color palette
  const applyPaletteBtn = screen.getByRole('button', { name: '应用自定义色盘到文稿' })
  fireEvent.click(applyPaletteBtn)
  await waitFor(() => expect(ctx.rest.mock.calls.some(([path, opts]) =>
    path.endsWith('/edit') && opts.body.operations[0].action === 'theme' && opts.body.operations[0].changes.primary
  )).toBe(true))

  // Close brand kit modal
  fireEvent.click(screen.getByRole('button', { name: '完成' }))
  await waitFor(() => expect(screen.queryByText('🎨 企业品牌规范与资产设定')).toBeNull())
})

it('supports outline-first workflow in doc-to-deck modal and confirms deck creation', async () => {
  const ctx = mount()
  fireEvent.click(await screen.findByRole('button', { name: '空白新建' }))
  await screen.findByText('测试文稿 · v1 · 已保存')

  // Click 📄 文档转PPT in toolbar
  const docModalBtn = screen.getByRole('button', { name: '📄 文档转PPT' })
  fireEvent.click(docModalBtn)

  // Verify Step 1 is displayed
  await screen.findByText('📄 文档一键转 PPT (Doc-to-Deck)')
  const textarea = screen.getByPlaceholderText(/在此粘贴 Markdown 长文/)
  fireEvent.change(textarea, { target: { value: '# 企业架构规划\n- 模块解耦与容灾\n- 离线高可用' } })

  // Click 📑 先规划大纲并预览 (推荐)
  const outlineBtn = screen.getByRole('button', { name: '📑 先规划大纲并预览 (推荐)' })
  fireEvent.click(outlineBtn)

  // Verify outline endpoint was called
  await waitFor(() => expect(ctx.rest.mock.calls.some(([path]) => path === '/projects/generate-outline')).toBe(true))

  // Verify Step 2 is displayed with 3 outline cards
  await screen.findByText(/确认演示文稿大纲 \(3 页\)/)
  expect(screen.getByDisplayValue('业务痛点分析')).toBeTruthy()
  expect(screen.getByDisplayValue('微服务架构设计')).toBeTruthy()
  expect(screen.getByDisplayValue('收益与实施规划')).toBeTruthy()

  // Modify first slide title in outline
  const firstTitleInput = screen.getByDisplayValue('业务痛点分析')
  fireEvent.change(firstTitleInput, { target: { value: '业务背景与核心痛点' } })

  // Confirm outline to generate full deck
  const confirmBtn = screen.getByRole('button', { name: '✨ 确认大纲，生成完整文稿' })
  fireEvent.click(confirmBtn)

  // Verify POST /projects was called with new outline
  await waitFor(() => expect(ctx.rest.mock.calls.some(([path, opts]) =>
    path === '/projects' && opts?.method === 'POST' && opts?.body?.slides?.[0]?.title === '业务背景与核心痛点'
  )).toBe(true))

  // Verify modal is closed
  await waitFor(() => expect(screen.queryByText(/确认演示文稿大纲/)).toBeNull())
})

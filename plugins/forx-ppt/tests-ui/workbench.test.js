import { createElement as h } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { host, QueryClient, QueryClientProvider } from './sdk.js'
import plugin from '../desktop/plugin.js'

const makeDocument = (name = '测试文稿') => ({ revision: 1, undo_available: false, redo_available: false, issues: [], deck: {
  id: 'project-a', name, width: 13.333333, height: 7.5, theme: { name: '商务简洁' },
  master: { id: 'M001', elements: [{ id: 'E0001', name: '品牌', kind: 'text', text: 'ACME', style: {}, box: { x: 10, y: .2, width: 2, height: .5 } }] },
  slides: [{ id: 'S001', name: '第一页', elements: [{ id: 'E0002', name: '主标题', kind: 'text', role: 'title', text: '原始标题', style: {} }] }],
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
      if (path === '/projects' && options?.method === 'POST') { current = makeDocument(); return current }
      if (path === '/projects') return { projects: current ? [{ id: current.deck.id, name: current.deck.name }] : [] }
      if (path.endsWith('/history')) return { history: [] }
      if (path.includes('/preview/')) return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><g data-element-id="E0002"><text>标题画布</text></g></svg>', assets: [], elements: [], revision: current?.revision || 1 }
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

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

const THEME_PRESETS = [
  { id: 'business', name: '💼 商务深蓝', primary: '#2459A8', accent: '#168C92', bg: '#FFFFFF', desc: '经典严谨商务质感，沉稳大气' },
  { id: 'technology', name: '⚡ 深色科技', primary: '#64AAFF', accent: '#49DEC5', bg: '#101C30', desc: '深蓝底色与荧光青，高科技极客范' },
  { id: 'minimal', name: '🌿 清新极简', primary: '#35745B', accent: '#B16B36', bg: '#F7F9F5', desc: '莫兰迪绿与暖木棕，典雅自然' },
  { id: 'crimson', name: '🍎 活力果红', primary: '#FF3B30', accent: '#FF9500', bg: '#FFFFFF', desc: 'Apple 红色与暖橙，张力十足' },
  { id: 'royal', name: '👑 尊贵雅致', primary: '#7C3AED', accent: '#C084FC', bg: '#0F0C20', desc: '暗夜曜紫与荧光紫，奢华高贵' },
  { id: 'elegant', name: '🍸 香槟轻奢', primary: '#A3704C', accent: '#D4A373', bg: '#FDFBF7', desc: '香槟暖金与咖啡棕，温馨雅致' }
]

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
    $docModalOpen: atom(false), $layoutModalOpen: atom(false), $deleteModalOpen: atom(false),
    $imageModalOpen: atom(false), $imageModalTargetElement: atom(null), $attachments: atom([]),
    $reLayoutModalOpen: atom(false),
    $presenting: atom(false), $laserActive: atom(false), $presenterNotesOpen: atom(false), $blackout: atom(false),
    $exportModalOpen: atom(false), $brandKitModalOpen: atom(false),
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
  state.delete = (id) => state.perform('删除文稿', async () => {
    const targetId = id || state.$doc.get()?.deck?.id
    if (!targetId) return
    await state.request(`/projects/${targetId}`, { method: 'DELETE' })
    if (state.$doc.get()?.deck?.id === targetId) {
      state.$doc.set(null)
      state.$slide.set(null)
      state.$selection.set([])
      state.$messages.set([])
      state.$before.set(null)
      state.$compare.set(false)
      ctx.storage.set(`project:${owner}`, null)
    }
    state.$deleteModalOpen.set(false)
    state.$refresh.set(state.$refresh.get() + 1)
  })
  state.addAttachment = (file) => state.perform('正在解析参考文件…', async () => {
    let parsedText = ''
    const ext = file.name.split('.').pop()?.toLowerCase() || ''
    if (['txt', 'md', 'markdown', 'csv', 'json', 'jsonl', 'rst', 'html', 'xml'].includes(ext)) {
      parsedText = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = e => resolve(String(e.target?.result || ''))
        reader.onerror = () => reject(new Error('无法读取文件文本'))
        reader.readAsText(file)
      })
    } else {
      const res = await state.request('/parse-file', {
        method: 'POST',
        timeoutMs: 60000,
        body: { filename: file.name, data: await fileData(file) }
      })
      parsedText = res.text || ''
    }
    const cleanText = parsedText.trim()
    if (!cleanText) {
      throw new Error(`未能从文件《${file.name}》中提取到有效文本`)
    }
    const item = {
      id: uid(),
      name: file.name,
      size: file.size,
      text: cleanText,
      charCount: cleanText.length
    }
    state.$attachments.set([...state.$attachments.get(), item])
  })
  state.removeAttachment = (id) => {
    state.$attachments.set(state.$attachments.get().filter(a => a.id !== id))
  }
  state.generateImage = (prompt, style = 'illustration', aspectRatio = 'landscape', elementId = null) => state.perform('正在生成高清配图…', async () => {
    const current = state.$doc.get()
    const slideId = state.$slide.get()
    const targetEl = elementId || state.$imageModalTargetElement.get() || null
    const res = await state.request('/generate-image', {
      method: 'POST',
      timeoutMs: 120000,
      body: {
        prompt,
        style,
        aspect_ratio: aspectRatio,
        project_id: current?.deck.id || null,
        slide_id: slideId || null,
        element_id: targetEl,
        request_id: uid(),
      }
    })
    state.$imageModalOpen.set(false)
    state.$imageModalTargetElement.set(null)
    if (res.result) {
      state.accept(res.result)
    }
    return res
  })
  state.relayoutSlide = (layoutId) => state.perform('正在智能重构页面排版…', async () => {
    const slideId = state.$slide.get()
    const current = state.$doc.get()
    if (!slideId || !current) return
    const l = LAYOUTS.find(x => x.id === layoutId)
    state.$reLayoutModalOpen.set(false)
    const result = await state.request(`/projects/${current.deck.id}/edit`, {
      method: 'POST',
      body: {
        revision: current.revision,
        operations: [{ action: 'relayout_slide', target: slideId, changes: { layout_id: layoutId } }],
        label: `智能重构页面版式为 · ${l?.name || layoutId}`,
        request_id: uid(),
      }
    })
    state.accept(result)
  })
  state.send = () => state.perform('正在理解指令并更新文稿…', async () => {
    const rawPrompt = state.$draft.get().trim()
    const attachments = state.$attachments.get()
    if (!rawPrompt && attachments.length === 0) return
    const prompt = rawPrompt || (attachments.length > 0 ? '请根据上传的参考文件内容，全面梳理并补充到本演示文稿中' : '')
    const current = state.$doc.get()
    const selection = state.$selection.get()

    const isImageCmd = /^(根据选定元素生图|为选定元素生图|为选中元素生图|选定元素生图|生图|生成配图|生成图片)[:：\s]*/i.test(prompt)
    if (isImageCmd && selection.length > 0) {
      const cleanImgPrompt = prompt.replace(/^(根据选定元素生图|为选定元素生图|为选中元素生图|选定元素生图|生图|生成配图|生成图片)[:：\s]*/i, '').trim() || '现代商业概念插画'
      state.$messages.set([...state.$messages.get(), { role: 'user', text: prompt }])
      state.$draft.set('')
      await state.generateImage(cleanImgPrompt, 'illustration', 'landscape', selection[0])
      state.$messages.set([...state.$messages.get(), { role: 'assistant', text: `已成功为选定元素 ${selection[0]} 生成高清配图并替换更新！` }])
      return
    }

    let fullPrompt = prompt
    if (attachments.length > 0) {
      const attachmentsText = attachments.map((att, idx) => `--- 附件 ${idx + 1}：《${att.name}》（${att.charCount || att.text.length} 字）---\n${att.text}`).join('\n\n')
      fullPrompt = `【用户上传的参考文件内容】\n${attachmentsText}\n\n【用户补充/修改要求】\n${prompt}`
    }

    const requestId = uid()
    state.$busy.set({ ...state.$busy.get(), label: current ? '正在理解指令并更新文稿…' : '正在生成页面…', requestId })
    state.$messages.set([...state.$messages.get(), {
      role: 'user',
      text: prompt,
      attachments: attachments.map(a => a.name)
    }])
    state.$draft.set('')
    state.$attachments.set([])

    const value = await state.request('/chat', { method: 'POST', timeoutMs: 150000, body: {
      prompt: fullPrompt, project_id: current?.deck.id || null, revision: current?.revision || null,
      selection, request_id: requestId,
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
  state.generateNotes = (slideId) => state.perform('正在为本页生成演讲讲稿…', async () => {
    const current = state.$doc.get()
    const targetId = slideId || state.$slide.get()
    if (!current || !targetId) return
    const res = await state.request(`/projects/${current.deck.id}/slides/${targetId}/generate-notes`, {
      method: 'POST',
      timeoutMs: 90000,
      body: { request_id: uid() }
    })
    if (res.result) {
      state.accept(res.result)
    }
  })
  state.updateNotes = (slideId, notes) => state.edit(
    [{ action: 'update_slide', target: slideId, changes: { notes } }],
    '更新演讲备注'
  )
  state.exportPptx = () => {
    state.$exportModalOpen.set(false)
    return state.download('pptx')
  }
  state.exportProject = () => {
    state.$exportModalOpen.set(false)
    return state.download('project')
  }
  state.exportPdf = () => {
    state.$exportModalOpen.set(false)
    window.print()
  }
  state.exportSlideImage = (slideId) => state.perform('正在导出单页图片…', async () => {
    const current = state.$doc.get()
    const targetId = slideId || state.$slide.get()
    if (!current || !targetId) return
    const currentSlide = current.deck.slides.find(s => s.id === targetId)
    const idx = current.deck.slides.findIndex(s => s.id === targetId)

    const data = await state.request(`/projects/${current.deck.id}/preview/${targetId}?revision=${current.revision}&numbers=false`)
    let svg = data.svg
    for (const assetId of (data.assets || [])) {
      const asset = await state.request(`/assets/${assetId}`)
      svg = svg.replaceAll(`forx-asset:${assetId}`, `data:${asset.content_type};base64,${asset.data}`)
    }

    const width = 1920
    const height = Math.round(width * (current.deck.height / current.deck.width))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx2d = canvas.getContext('2d')

    const img = new Image()
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)

    await new Promise((resolve, reject) => {
      img.onload = () => {
        ctx2d.drawImage(img, 0, 0, width, height)
        URL.revokeObjectURL(url)
        resolve()
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('单页图片绘制失败'))
      }
      img.src = url
    })

    canvas.toBlob(outBlob => {
      if (!outBlob) return
      const downloadUrl = URL.createObjectURL(outBlob)
      const anchor = document.createElement('a')
      anchor.href = downloadUrl
      anchor.download = `${current.deck.name}_第${idx + 1}页_${currentSlide?.name || targetId}.png`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 30000)
    }, 'image/png')
    state.$exportModalOpen.set(false)
  })
  state.exportLongImage = () => state.perform('正在合成全篇长图海报…', async () => {
    const current = state.$doc.get()
    if (!current) return
    const slides = current.deck.slides
    if (!slides?.length) return

    const slideW = 1920
    const slideH = Math.round(slideW * (current.deck.height / current.deck.width))
    const marginX = 80
    const gapY = 48
    const headerH = 220
    const footerH = 120
    const totalW = slideW + marginX * 2
    const totalH = headerH + slides.length * (slideH + gapY) + footerH

    const canvas = document.createElement('canvas')
    canvas.width = totalW
    canvas.height = totalH
    const ctx2d = canvas.getContext('2d')

    ctx2d.fillStyle = '#0f141c'
    ctx2d.fillRect(0, 0, totalW, totalH)

    ctx2d.fillStyle = '#ffffff'
    ctx2d.font = 'bold 56px -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif'
    ctx2d.textAlign = 'center'
    ctx2d.fillText(current.deck.name, totalW / 2, 90)

    ctx2d.fillStyle = '#8e8e93'
    ctx2d.font = '24px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif'
    ctx2d.fillText(`ForX-PPT · 全篇精粹共 ${slides.length} 页 · 生成于 ${new Date().toLocaleDateString('zh-CN')}`, totalW / 2, 140)

    ctx2d.strokeStyle = '#2c2c2e'
    ctx2d.lineWidth = 2
    ctx2d.beginPath()
    ctx2d.moveTo(totalW / 2 - 200, 175)
    ctx2d.lineTo(totalW / 2 + 200, 175)
    ctx2d.stroke()

    let currentY = headerH
    for (let i = 0; i < slides.length; i++) {
      const s = slides[i]
      const data = await state.request(`/projects/${current.deck.id}/preview/${s.id}?revision=${current.revision}&numbers=false`)
      let svg = data.svg
      for (const assetId of (data.assets || [])) {
        const asset = await state.request(`/assets/${assetId}`)
        svg = svg.replaceAll(`forx-asset:${assetId}`, `data:${asset.content_type};base64,${asset.data}`)
      }

      const img = new Image()
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(blob)

      await new Promise(resolve => {
        img.onload = () => {
          ctx2d.save()
          ctx2d.shadowColor = 'rgba(0, 0, 0, 0.45)'
          ctx2d.shadowBlur = 32
          ctx2d.shadowOffsetY = 16
          ctx2d.fillStyle = '#1c1c1e'
          ctx2d.beginPath()
          ctx2d.roundRect(marginX, currentY, slideW, slideH, 16)
          ctx2d.fill()
          ctx2d.restore()

          ctx2d.save()
          ctx2d.beginPath()
          ctx2d.roundRect(marginX, currentY, slideW, slideH, 16)
          ctx2d.clip()
          ctx2d.drawImage(img, marginX, currentY, slideW, slideH)
          ctx2d.restore()

          ctx2d.fillStyle = 'rgba(0, 113, 227, 0.9)'
          ctx2d.beginPath()
          ctx2d.roundRect(marginX + 24, currentY + 24, 90, 32, 16)
          ctx2d.fill()

          ctx2d.fillStyle = '#ffffff'
          ctx2d.font = 'bold 15px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif'
          ctx2d.textAlign = 'center'
          ctx2d.fillText(`${i + 1} / ${slides.length}`, marginX + 69, currentY + 45)

          URL.revokeObjectURL(url)
          resolve()
        }
        img.onerror = () => {
          URL.revokeObjectURL(url)
          resolve()
        }
        img.src = url
      })

      currentY += slideH + gapY
    }

    ctx2d.fillStyle = '#636366'
    ctx2d.font = '20px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif'
    ctx2d.textAlign = 'center'
    ctx2d.fillText('Generated by ForX Agent · AI Native Native-Editable Presentation', totalW / 2, totalH - 50)

    canvas.toBlob(outBlob => {
      if (!outBlob) return
      const downloadUrl = URL.createObjectURL(outBlob)
      const anchor = document.createElement('a')
      anchor.href = downloadUrl
      anchor.download = `${current.deck.name}_全篇长图.png`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 30000)
    }, 'image/png')
    state.$exportModalOpen.set(false)
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
      button('🎨 AI生图', () => c.$imageModalOpen.set(true), !!busy),
      button('导入', () => upload.current.click(), !!busy),
    ),
    h('input', { ref: upload, type: 'file', accept: '.pptx,.forxppt', hidden: true, onChange: event => {
      const file = event.target.files[0]; event.target.value = ''; if (file) void c.importFile(file)
    } }),
    doc && h('div', { className: 'ppt-btn-group' },
      button('🎨 品牌规范', () => c.$brandKitModalOpen.set(true), !doc, { title: '自定义品牌配色盘与母版企业Logo' }),
    ),
    doc && h('select', { className: 'ppt-theme-select', 'aria-label': 'PPT 主题', disabled: !!busy,
      value: Object.keys({ business: 1, technology: 1, minimal: 1, crimson: 1, royal: 1, elegant: 1 }).find(k => ({
        business: '商务简洁', technology: '深色科技', minimal: '清新极简',
        crimson: '活力果红', royal: '尊贵雅致', elegant: '香槟轻奢'
      })[k] === doc.deck.theme.name) || '',
      onChange: event => void c.edit([{ action: 'theme', changes: { preset: event.target.value } }], '切换文稿主题') },
      h('option', { value: '', disabled: true }, '选择主题风格'),
      h('option', { value: 'business' }, '💼 商务简洁'),
      h('option', { value: 'technology' }, '⚡ 深色科技'),
      h('option', { value: 'minimal' }, '🌿 清新极简'),
      h('option', { value: 'crimson' }, '🍎 活力果红'),
      h('option', { value: 'royal' }, '👑 尊贵雅致'),
      h('option', { value: 'elegant' }, '🍸 香槟轻奢')
    ),
    doc && h('div', { className: 'ppt-btn-group' },
      button(numbers ? '隐藏编号' : '显示编号', () => c.$numbers.set(!c.$numbers.get())),
      button('撤销', () => c.travel('undo'), !!busy || !doc?.undo_available),
      button('重做', () => c.travel('redo'), !!busy || !doc?.redo_available),
    ),
    doc && h('div', { className: 'ppt-btn-group' },
      button('▶ 放映', () => c.$presenting.set(true), !doc, { title: '全屏演示放映 (快捷键 F5)', className: 'ppt-btn-present' }),
      button('📤 导出', () => c.$exportModalOpen.set(true), !doc, { className: 'ppt-btn-primary', title: '导出 PPTX、PDF、长图与工程包' }),
      button('保存项目', () => c.download('project'), !!busy || !doc),
      button('导出 PPTX', () => c.download('pptx'), !!busy || !doc),
      button('删除文稿', () => c.$deleteModalOpen.set(true), !!busy, { className: 'ppt-btn-danger' }),
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

const DOC_PRESETS = [
  {
    label: '💼 商业计划书 (BP)',
    title: 'Hermes Agent 商业化与产品战略规划',
    text: `# Hermes Agent 商业化与产品战略规划

## 1. 项目愿景与使命
- 打造极致优雅、端侧优先的个人 AI Agent 工作台与多模态创作底座。
- 深度适配 Apple HIG Cupertino 美学标准，融合现代交互与本地模型能力。

## 2. 行业痛点与市场机遇
- 传统演示文稿制作耗时耗力，多端协作与格式排版摩擦严重。
- 现有 AI PPT 工具大多依赖公有云，企业内部敏感数据面临泄露风险。
- 本地私有化、轻量级、高颜值的专业 PPTX 原生生成处于市场空白。

## 3. 核心优势与技术壁垒
- 微内核设计：核心窄腰，能力外延，按需热插拔插件生态。
- 10 类高阶商务排版矩阵：封面、时间轴、四象限、指标大屏一应俱全。
- 无感延迟：离线即时编译与双向响应式双活状态流。

## 4. 商业模式与商业化落地
- 社区开源版沉淀全球开发者口碑与模型生态连接。
- 企业私有化部署版提供多租户隔离、审计追踪与品牌模板深度定制。`
  },
  {
    label: '📊 季度业务复盘',
    title: '2024 Q3 团队核心业务与技术战报复盘',
    text: `# 2024 Q3 团队核心业务与技术战报复盘

## 1. 核心关键指标战报
- 99.99% 核心系统 SLA 业务可用性，零重大生产事故。
- 300% 演示文稿全流程创作提效倍率，平均耗时降至 1.8 秒。
- 50,000+ 累计服务团队与关键商务汇报场次。

## 2. 重点突破与亮点成果
- 全新版式矩阵上线：支持多列卡片、方案对比与关键指标大屏。
- 全面对齐 Cupertino 视觉语言：磨砂玻璃、超椭圆圆角与灵动微动效。
- 状态机机制重构：支持完备的撤销/重做与原子化操作集。

## 3. 业务挑战与应对策略
- 针对长文大纲提炼碎片化问题，引入版式自适应权重决策树。
- 针对跨端字体渲染差异，优化本地字体回退与度量计算链。

## 4. 下季度演进路线规划
- 探索多轮自然语言深度协同交互与智能演讲者备注生成。
- 推进跨平台移动端与平板端画布自适应排版。`
  },
  {
    label: '🛠️ 技术架构方案',
    title: '高可用 AI 演示引擎技术架构演进方案',
    text: `# 高可用 AI 演示引擎技术架构演进方案

## 1. 业务背景与系统演进诉求
- 应对复杂长文大纲的智能解析，解决传统方案上下文截断与版式僵化问题。
- 构建端到端零摩擦、无公网依赖的本地原生排版渲染管线。

## 2. 总体分层架构设计
- 客户端层：Electron + React 声明式渲染，结合轻量状态控制器。
- 契约网关层：严格 JSON Schema 校验与幂等请求上下文管理。
- 渲染核心层：基于 Python-PPTX 的参数化矢量几何布局引擎。

## 3. 关键技术实现与创新
- 基于 AST 语意树的文本大纲自动分块与版式智能匹配算法。
- 统一原子化操作命令集（add/edit/delete/reorder），实现无损操作历史。
- 进程外隔离执行，确保复杂长任务下 UI 主线程始终保持 60fps。

## 4. 可靠性与安全性保障
- 离线沙箱环境安全执行，用户原始数据与产物不离开本地磁盘。
- 完备的自动化回归测试矩阵，覆盖 UI 端与 Python 引擎契约。`
  }
]

function LayoutWireframe({ id }) {
  const bg = 'var(--ppt-wf-bg, rgba(120, 120, 128, 0.08))'
  const border = 'var(--ppt-wf-border, rgba(120, 120, 128, 0.16))'
  const primary = '#0071e3'
  const ink = 'var(--ppt-wf-ink, #6e6e73)'
  const cardBg = 'var(--ppt-wf-card, rgba(120, 120, 128, 0.12))'

  let content = null
  if (id === 'L001') {
    content = [
      h('rect', { key: 't', x: 26, y: 34, width: 108, height: 11, rx: 3, fill: primary }),
      h('rect', { key: 's', x: 44, y: 50, width: 72, height: 6, rx: 2, fill: ink, opacity: 0.5 }),
    ]
  } else if (id === 'L002') {
    content = [
      h('rect', { key: 't', x: 14, y: 12, width: 44, height: 6, rx: 2, fill: primary }),
      ...[26, 39, 52, 65].map((y, idx) => h('g', { key: idx },
        h('circle', { cx: 20, cy: y + 3, r: 2.5, fill: primary }),
        h('rect', { x: 27, y, width: 85 + (idx % 2 === 0 ? 20 : 0), height: 5, rx: 2, fill: ink, opacity: 0.6 })
      ))
    ]
  } else if (id === 'L003') {
    content = [
      h('rect', { key: 't', x: 14, y: 12, width: 55, height: 6, rx: 2, fill: primary }),
      h('rect', { key: 'b1', x: 14, y: 26, width: 132, height: 5, rx: 2, fill: ink, opacity: 0.6 }),
      h('rect', { key: 'b2', x: 14, y: 37, width: 126, height: 5, rx: 2, fill: ink, opacity: 0.5 }),
      h('rect', { key: 'b3', x: 14, y: 48, width: 130, height: 5, rx: 2, fill: ink, opacity: 0.5 }),
      h('rect', { key: 'b4', x: 14, y: 59, width: 92, height: 5, rx: 2, fill: ink, opacity: 0.4 }),
    ]
  } else if (id === 'L004') {
    content = [
      h('rect', { key: 't', x: 14, y: 12, width: 50, height: 6, rx: 2, fill: primary }),
      h('rect', { key: 'img', x: 14, y: 25, width: 60, height: 50, rx: 4, fill: cardBg, stroke: border, strokeWidth: 1 }),
      h('circle', { key: 'ic', cx: 34, cy: 45, r: 6, fill: primary, opacity: 0.4 }),
      h('rect', { key: 'b1', x: 82, y: 28, width: 64, height: 5, rx: 2, fill: ink, opacity: 0.7 }),
      h('rect', { key: 'b2', x: 82, y: 41, width: 58, height: 5, rx: 2, fill: ink, opacity: 0.5 }),
      h('rect', { key: 'b3', x: 82, y: 54, width: 62, height: 5, rx: 2, fill: ink, opacity: 0.5 }),
    ]
  } else if (id === 'L006') {
    content = [
      h('rect', { key: 't', x: 14, y: 12, width: 44, height: 6, rx: 2, fill: primary }),
      h('line', { key: 'line', x1: 20, y1: 45, x2: 140, y2: 45, stroke: primary, strokeWidth: 1.5, opacity: 0.7 }),
      ...[26, 62, 98, 134].map((x, idx) => h('g', { key: idx },
        h('circle', { cx: x, cy: 45, r: 4, fill: '#ffffff', stroke: primary, strokeWidth: 2 }),
        h('rect', { x: x - 12, y: idx % 2 === 0 ? 25 : 55, width: 24, height: 5, rx: 2, fill: ink, opacity: 0.7 })
      ))
    ]
  } else if (id === 'L007') {
    content = [
      h('rect', { key: 't', x: 14, y: 12, width: 48, height: 6, rx: 2, fill: primary }),
      ...[14, 60, 106].map((x, idx) => h('g', { key: idx },
        h('rect', { x, y: 25, width: 40, height: 50, rx: 4, fill: cardBg, stroke: border, strokeWidth: 1 }),
        h('rect', { x: x + 6, y: 31, width: 20, height: 4, rx: 1.5, fill: primary, opacity: 0.8 }),
        h('rect', { x: x + 6, y: 40, width: 28, height: 3, rx: 1, fill: ink, opacity: 0.5 }),
        h('rect', { x: x + 6, y: 47, width: 24, height: 3, rx: 1, fill: ink, opacity: 0.4 }),
      ))
    ]
  } else if (id === 'L008') {
    content = [
      h('rect', { key: 't', x: 14, y: 12, width: 48, height: 6, rx: 2, fill: primary }),
      ...[14, 60, 106].map((x, idx) => h('g', { key: idx },
        h('rect', { x, y: 25, width: 40, height: 50, rx: 4, fill: cardBg, stroke: border, strokeWidth: 1 }),
        h('rect', { x: x + 6, y: 34, width: 26, height: 10, rx: 2, fill: primary }),
        h('rect', { x: x + 6, y: 52, width: 28, height: 4, rx: 1.5, fill: ink, opacity: 0.6 }),
      ))
    ]
  } else if (id === 'L009') {
    content = [
      h('rect', { key: 't', x: 14, y: 12, width: 48, height: 6, rx: 2, fill: primary }),
      h('rect', { key: 'q1', x: 18, y: 24, width: 58, height: 24, rx: 3, fill: '#34c759', opacity: 0.25 }),
      h('rect', { key: 'q2', x: 84, y: 24, width: 58, height: 24, rx: 3, fill: '#ff9500', opacity: 0.25 }),
      h('rect', { key: 'q3', x: 18, y: 52, width: 58, height: 24, rx: 3, fill: '#0071e3', opacity: 0.25 }),
      h('rect', { key: 'q4', x: 84, y: 52, width: 58, height: 24, rx: 3, fill: '#ff3b30', opacity: 0.25 }),
      h('rect', { key: 'q1-t', x: 24, y: 31, width: 32, height: 4, rx: 1.5, fill: ink, opacity: 0.7 }),
      h('rect', { key: 'q2-t', x: 90, y: 31, width: 32, height: 4, rx: 1.5, fill: ink, opacity: 0.7 }),
      h('rect', { key: 'q3-t', x: 24, y: 59, width: 32, height: 4, rx: 1.5, fill: ink, opacity: 0.7 }),
      h('rect', { key: 'q4-t', x: 90, y: 59, width: 32, height: 4, rx: 1.5, fill: ink, opacity: 0.7 }),
    ]
  } else if (id === 'L010') {
    content = [
      h('rect', { key: 't', x: 14, y: 12, width: 48, height: 6, rx: 2, fill: primary }),
      h('rect', { key: 'c1', x: 16, y: 25, width: 60, height: 50, rx: 4, fill: cardBg, stroke: primary, strokeWidth: 1 }),
      h('rect', { key: 'c1-h', x: 22, y: 31, width: 28, height: 5, rx: 1.5, fill: primary }),
      h('rect', { key: 'c1-l1', x: 22, y: 42, width: 46, height: 3, rx: 1, fill: ink, opacity: 0.6 }),
      h('rect', { key: 'c1-l2', x: 22, y: 50, width: 42, height: 3, rx: 1, fill: ink, opacity: 0.5 }),
      h('rect', { key: 'c2', x: 84, y: 25, width: 60, height: 50, rx: 4, fill: cardBg, stroke: border, strokeWidth: 1 }),
      h('rect', { key: 'c2-h', x: 90, y: 31, width: 28, height: 5, rx: 1.5, fill: ink, opacity: 0.8 }),
      h('rect', { key: 'c2-l1', x: 90, y: 42, width: 46, height: 3, rx: 1, fill: ink, opacity: 0.6 }),
      h('rect', { key: 'c2-l2', x: 90, y: 50, width: 42, height: 3, rx: 1, fill: ink, opacity: 0.5 }),
    ]
  } else if (id === 'L005') {
    content = [
      h('rect', { key: 'card', x: 34, y: 26, width: 92, height: 38, rx: 6, fill: cardBg, stroke: primary, strokeWidth: 1 }),
      h('rect', { key: 't', x: 50, y: 36, width: 60, height: 7, rx: 2, fill: primary }),
      h('rect', { key: 's', x: 58, y: 49, width: 44, height: 4, rx: 1.5, fill: ink, opacity: 0.6 }),
    ]
  }

  return h('div', { className: 'ppt-wireframe-wrap' },
    h('svg', {
      viewBox: '0 0 160 90',
      className: 'ppt-wireframe-svg',
      style: { width: '100%', height: 'auto', display: 'block' }
    },
      h('rect', { x: 0.5, y: 0.5, width: 159, height: 89, rx: 6, fill: bg, stroke: border, strokeWidth: 1 }),
      content
    )
  )
}

function SegmentedControl({ options, value, onChange, disabled }) {
  return h('div', { className: 'ppt-cupertino-segmented', role: 'tablist' },
    options.map(opt => {
      const isSelected = opt.value === value
      return h('button', {
        key: String(opt.value),
        type: 'button',
        role: 'tab',
        'aria-selected': isSelected,
        disabled,
        className: `ppt-cupertino-segment ${isSelected ? 'ppt-cupertino-segment-active' : ''}`,
        onClick: () => onChange(opt.value)
      }, opt.label)
    })
  )
}

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
  return h('div', { className: 'ppt-modal-backdrop ppt-cupertino-backdrop', onClick: () => c.$layoutModalOpen.set(false) },
    h('div', { className: 'ppt-modal ppt-layout-modal ppt-cupertino-sheet', onClick: e => e.stopPropagation() },
      h('div', { className: 'ppt-modal-header ppt-cupertino-sheet-header' },
        h('div', { className: 'ppt-header-text-group' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { className: 'ppt-apple-badge' }, 'Layouts'),
            h('h3', { className: 'ppt-modal-title' }, '选择新增页面版式 (10 类专业版式)')
          ),
          h('p', { className: 'ppt-muted', style: { margin: '4px 0 0' } }, '点击卡片立即插入页面，自动填充规范结构与示范要点')
        ),
        h('button', {
          className: 'ppt-cupertino-close-btn',
          'aria-label': '关闭',
          onClick: () => c.$layoutModalOpen.set(false)
        }, '✕')
      ),
      h('div', { className: 'ppt-layout-grid ppt-cupertino-layout-grid' },
        LAYOUTS.map(l => h('div', {
          key: l.id,
          className: 'ppt-layout-card ppt-cupertino-card',
          onClick: () => handleSelect(l)
        },
          h(LayoutWireframe, { id: l.id }),
          h('div', { className: 'ppt-layout-card-content' },
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
          )
        ))
      ),
      h('div', { className: 'ppt-modal-footer ppt-cupertino-sheet-footer' },
        h('button', {
          type: 'button',
          className: 'ppt-apple-btn-secondary',
          onClick: () => c.$layoutModalOpen.set(false)
        }, '取消'),
        h('button', {
          type: 'button',
          className: 'ppt-apple-btn-primary',
          onClick: () => handleSelect(LAYOUTS[2])
        }, '插入标准空白正文页 (L003)')
      )
    )
  )
}

function SlideReLayoutModal({ c }) {
  const open = useValue(c.$reLayoutModalOpen), busy = useValue(c.$busy)
  const doc = useValue(c.$doc), slideId = useValue(c.$slide)
  if (!open || !doc) return null
  const currentSlide = doc.deck.slides.find(s => s.id === slideId)
  if (!currentSlide) return null

  const handleSelect = (l) => {
    c.relayoutSlide(l.id)
  }

  return h('div', { className: 'ppt-modal-backdrop ppt-cupertino-backdrop', onClick: () => !busy && c.$reLayoutModalOpen.set(false) },
    h('div', { className: 'ppt-modal ppt-layout-modal ppt-cupertino-sheet', onClick: e => e.stopPropagation() },
      h('div', { className: 'ppt-modal-header ppt-cupertino-sheet-header' },
        h('div', { className: 'ppt-header-text-group' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { className: 'ppt-apple-badge' }, 'Smart Re-Layout'),
            h('h3', { className: 'ppt-modal-title' }, `✨ 智能重构本页排版 (${currentSlide.id} · ${currentSlide.name})`)
          ),
          h('p', { className: 'ppt-muted', style: { margin: '4px 0 0' } }, '选择目标专业版式，AI 将自动继承本页核心论点并自适应拆解为高密度卡片、时间轴或关键指标')
        ),
        h('button', {
          className: 'ppt-cupertino-close-btn',
          'aria-label': '关闭',
          disabled: !!busy,
          onClick: () => !busy && c.$reLayoutModalOpen.set(false)
        }, '✕')
      ),
      h('div', { className: 'ppt-layout-grid ppt-cupertino-layout-grid' },
        LAYOUTS.map(l => {
          const isCurrent = l.id === currentSlide.layout_id
          return h('div', {
            key: l.id,
            className: `ppt-layout-card ppt-cupertino-card ${isCurrent ? 'ppt-layout-card-current' : ''}`,
            onClick: () => !isCurrent && !busy && handleSelect(l)
          },
            h(LayoutWireframe, { id: l.id }),
            h('div', { className: 'ppt-layout-card-content' },
              h('div', { className: 'ppt-layout-card-header' },
                h('span', { className: 'ppt-layout-card-icon' }, l.icon),
                h('div', { className: 'ppt-layout-card-meta' },
                  h('span', { className: 'ppt-layout-card-id' }, l.id),
                  h('strong', { className: 'ppt-layout-card-name' }, l.name),
                ),
                isCurrent && h('span', { className: 'ppt-current-badge' }, '当前版式')
              ),
              h('p', { className: 'ppt-layout-card-desc' }, l.desc),
              h('button', {
                type: 'button',
                className: isCurrent ? 'ppt-apple-btn-secondary ppt-btn-sm' : 'ppt-apple-btn-primary ppt-btn-sm',
                disabled: isCurrent || !!busy,
                onClick: (e) => { e.stopPropagation(); if (!isCurrent && !busy) handleSelect(l) }
              }, isCurrent ? '当前版式' : '一键重构')
            )
          )
        })
      ),
      h('div', { className: 'ppt-modal-footer ppt-cupertino-sheet-footer' },
        h('span', { className: 'ppt-muted', style: { marginRight: 'auto', fontSize: 11 } }, '智能重构保留完整无损撤销/重做历史，随时可按撤销还原'),
        h('button', {
          type: 'button',
          className: 'ppt-apple-btn-secondary',
          disabled: !!busy,
          onClick: () => c.$reLayoutModalOpen.set(false)
        }, '取消')
      )
    )
  )
}

function BrandKitModal({ c }) {
  const doc = useValue(c.$doc)
  const open = useValue(c.$brandKitModalOpen)
  const busy = useValue(c.$busy)
  const [primary, setPrimary] = useState('#2459A8')
  const [accent, setAccent] = useState('#168C92')
  const [bg, setBg] = useState('#FFFFFF')
  const [text, setText] = useState('#17243B')
  const [logoCorner, setLogoCorner] = useState('tr')
  const logoInputRef = useRef(null)

  useEffect(() => {
    if (doc?.deck?.theme) {
      setPrimary(doc.deck.theme.primary || '#2459A8')
      setAccent(doc.deck.theme.accent || '#168C92')
      setBg(doc.deck.theme.background || '#FFFFFF')
      setText(doc.deck.theme.text || '#17243B')
    }
  }, [doc?.deck?.theme])

  if (!open || !doc) return null

  const masterLogo = doc.deck.master.elements.find(e => e.kind === 'image' && (e.name.includes('Logo') || e.name.includes('logo')))

  const handleApplyPalette = () => {
    c.edit([{
      action: 'theme',
      changes: { primary, accent, background: bg, text }
    }], '应用自定义品牌色盘')
  }

  const handleApplyPreset = (presetId) => {
    c.edit([{
      action: 'theme',
      changes: { preset: presetId }
    }], `切换品牌主题 · ${presetId}`)
  }

  const handleUploadLogo = async (file) => {
    if (!file) return
    await c.perform('正在设置全局母版 Logo…', async () => {
      const asset = await c.request('/assets', { method: 'POST', body: { data: await fileData(file) } })
      const logoW = 1.4, logoH = 0.5
      const coords = {
        tl: { x: 0.6, y: 0.3 },
        tr: { x: doc.deck.width - logoW - 0.6, y: 0.3 },
        bl: { x: 0.6, y: doc.deck.height - logoH - 0.4 },
        br: { x: doc.deck.width - logoW - 0.6, y: doc.deck.height - logoH - 0.4 }
      }[logoCorner] || { x: doc.deck.width - logoW - 0.6, y: 0.3 }

      const operation = masterLogo
        ? { action: 'update_element', target: masterLogo.id, changes: { asset_id: asset.asset_id, box: { ...coords, width: logoW, height: logoH } } }
        : { action: 'add_element', target: 'M001', element: { kind: 'image', name: `品牌Logo (${file.name.slice(0, 32)})`, asset_id: asset.asset_id, box: { ...coords, width: logoW, height: logoH } } }

      await c.edit([operation], '设置全局母版 Logo')
    })
  }

  const handleRemoveLogo = () => {
    if (!masterLogo) return
    c.edit([{ action: 'delete_element', target: masterLogo.id }], '移除全局母版 Logo')
  }

  return h('div', { className: 'ppt-modal-backdrop ppt-cupertino-backdrop', onClick: () => !busy && c.$brandKitModalOpen.set(false) },
    h('div', { className: 'ppt-modal ppt-brandkit-modal ppt-cupertino-sheet', onClick: e => e.stopPropagation() },
      h('div', { className: 'ppt-modal-header ppt-cupertino-sheet-header' },
        h('div', { className: 'ppt-header-text-group' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { className: 'ppt-apple-badge' }, 'Brand Kit'),
            h('h3', { className: 'ppt-modal-title' }, '🎨 企业品牌规范与资产设定')
          ),
          h('p', { className: 'ppt-muted', style: { margin: '4px 0 0' } }, '统一管理全篇幻灯片的品牌色盘、主辅色系及母版全局 Logo 资产')
        ),
        h('button', {
          className: 'ppt-cupertino-close-btn',
          'aria-label': '关闭',
          disabled: !!busy,
          onClick: () => !busy && c.$brandKitModalOpen.set(false)
        }, '✕')
      ),
      h('div', { className: 'ppt-modal-body ppt-cupertino-sheet-body' },
        h('div', { className: 'ppt-brandkit-section' },
          h('h4', { className: 'ppt-section-title' }, '1. 快速切换精选品牌主题'),
          h('div', { className: 'ppt-preset-themes-grid' },
            THEME_PRESETS.map(t => {
              const isCurrent = doc.deck.theme.name === t.name.replace(/^[^\s]+\s*/, '')
              return h('div', {
                key: t.id,
                className: `ppt-theme-card ${isCurrent ? 'ppt-theme-card-active' : ''}`,
                onClick: () => !busy && handleApplyPreset(t.id)
              },
                h('div', { className: 'ppt-theme-palette-bar' },
                  h('span', { style: { background: t.primary } }),
                  h('span', { style: { background: t.accent } }),
                  h('span', { style: { background: t.bg } })
                ),
                h('div', { className: 'ppt-theme-card-body' },
                  h('strong', { className: 'ppt-theme-name' }, t.name),
                  h('p', { className: 'ppt-theme-desc' }, t.desc)
                ),
                isCurrent && h('span', { className: 'ppt-theme-current-badge' }, '✓ 当前')
              )
            })
          )
        ),
        h('div', { className: 'ppt-brandkit-section' },
          h('h4', { className: 'ppt-section-title' }, '2. 自定义精确色盘'),
          h('div', { className: 'ppt-custom-colors-grid' },
            h('div', { className: 'ppt-color-picker-item' },
              h('label', { className: 'ppt-color-label' }, '主品牌色 (Primary)'),
              h('div', { className: 'ppt-color-input-wrapper' },
                h('input', { type: 'color', value: primary, onChange: e => setPrimary(e.target.value) }),
                h('input', { className: 'ppt-hex-input', value: primary, onChange: e => setPrimary(e.target.value) })
              )
            ),
            h('div', { className: 'ppt-color-picker-item' },
              h('label', { className: 'ppt-color-label' }, '辅助强调色 (Accent)'),
              h('div', { className: 'ppt-color-input-wrapper' },
                h('input', { type: 'color', value: accent, onChange: e => setAccent(e.target.value) }),
                h('input', { className: 'ppt-hex-input', value: accent, onChange: e => setAccent(e.target.value) })
              )
            ),
            h('div', { className: 'ppt-color-picker-item' },
              h('label', { className: 'ppt-color-label' }, '画布底色 (Background)'),
              h('div', { className: 'ppt-color-input-wrapper' },
                h('input', { type: 'color', value: bg, onChange: e => setBg(e.target.value) }),
                h('input', { className: 'ppt-hex-input', value: bg, onChange: e => setBg(e.target.value) })
              )
            ),
            h('div', { className: 'ppt-color-picker-item' },
              h('label', { className: 'ppt-color-label' }, '正文字色 (Text)'),
              h('div', { className: 'ppt-color-input-wrapper' },
                h('input', { type: 'color', value: text, onChange: e => setText(e.target.value) }),
                h('input', { className: 'ppt-hex-input', value: text, onChange: e => setText(e.target.value) })
              )
            )
          ),
          button('应用自定义色盘到文稿', handleApplyPalette, !!busy, { className: 'ppt-apple-btn-primary', style: { alignSelf: 'flex-start', marginTop: 10 } })
        ),
        h('div', { className: 'ppt-brandkit-section' },
          h('h4', { className: 'ppt-section-title' }, '3. 全局母版企业 Logo (跨全篇展示)'),
          h('div', { className: 'ppt-logo-asset-card' },
            h('div', { className: 'ppt-logo-preview-box' },
              masterLogo ? h('span', { className: 'ppt-logo-active-text' }, `✓ 已设置全局 Logo：${masterLogo.name}`) : h('span', { className: 'ppt-muted' }, '尚未设置全局母版 Logo')
            ),
            h('div', { className: 'ppt-logo-controls' },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('span', { className: 'ppt-field-label', style: { width: 'auto' } }, '图钉位置：'),
                h('select', {
                  className: 'ppt-input ppt-cupertino-input',
                  style: { width: 140 },
                  value: logoCorner,
                  onChange: e => setLogoCorner(e.target.value)
                },
                  h('option', { value: 'tr' }, '↗️ 右上角 (推荐)'),
                  h('option', { value: 'tl' }, '↖️ 左上角'),
                  h('option', { value: 'br' }, '↘️ 右下角'),
                  h('option', { value: 'bl' }, '↙️ 左下角')
                )
              ),
              h('input', {
                type: 'file',
                accept: 'image/png,image/jpeg,image/svg+xml,image/webp',
                style: { display: 'none' },
                ref: logoInputRef,
                onChange: e => {
                  const f = e.target.files?.[0]
                  if (f) void handleUploadLogo(f)
                  e.target.value = ''
                }
              }),
              h('div', { style: { display: 'flex', gap: 8 } },
                button('上传并应用全局 Logo', () => logoInputRef.current?.click(), !!busy, { className: 'ppt-apple-btn-primary' }),
                masterLogo && button('移除全局 Logo', handleRemoveLogo, !!busy, { className: 'ppt-btn-danger' })
              )
            )
          )
        )
      ),
      h('div', { className: 'ppt-modal-footer ppt-cupertino-sheet-footer' },
        h('span', { className: 'ppt-muted', style: { marginRight: 'auto', fontSize: 11 } }, '母版 Logo 写入 M001，导出为 PPTX 后在 Office 中位于真正的幻灯片母版层'),
        h('button', {
          type: 'button',
          className: 'ppt-apple-btn-secondary',
          onClick: () => c.$brandKitModalOpen.set(false)
        }, '完成')
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
  const [step, setStep] = useState('input')
  const [outlineData, setOutlineData] = useState(null)

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
      setStep('input')
      setOutlineData(null)
      setDocText('')
      setTitle('')
      c.accept(res.result)
    })
  }

  const handleGenerateOutline = async () => {
    if (!docText.trim() || docText.trim().length < 5) {
      c.$error.set('请输入至少5个字符的文档正文或大纲内容')
      return
    }
    await c.perform('正在智能规划演示文稿大纲…', async () => {
      const res = await c.request('/projects/generate-outline', {
        method: 'POST',
        timeoutMs: 120000,
        body: {
          text: docText.trim(),
          title: title.trim() || undefined,
          target_pages: parseInt(targetPages, 10) || 8
        }
      })
      setOutlineData(res)
      setStep('outline')
    })
  }

  const handleConfirmOutline = async () => {
    if (!outlineData?.slides?.length) return
    await c.perform('正在根据大纲生成完整文稿…', async () => {
      const payload = {
        name: outlineData.title || title.trim() || '未命名演示文稿',
        slides: outlineData.slides.map(s => ({
          title: s.title,
          layout_id: s.layout_id,
          bullets: Array.isArray(s.bullets) ? s.bullets : String(s.bullets).split('\n').filter(Boolean)
        })),
        theme,
        ratio,
        request_id: uid()
      }
      const res = await c.request('/projects', {
        method: 'POST',
        body: payload
      })
      c.$docModalOpen.set(false)
      setStep('input')
      setOutlineData(null)
      setDocText('')
      setTitle('')
      c.accept(res)
    })
  }

  const handleFileImport = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const content = ev.target?.result
      if (typeof content === 'string') {
        setDocText(content)
        if (!title.trim()) {
          const cleanName = file.name.replace(/\.[^/.]+$/, '')
          setTitle(cleanName)
        }
      }
    }
    reader.readAsText(file)
  }

  const charCount = docText.trim().length
  const isTextValid = charCount >= 5

  if (step === 'outline' && outlineData) {
    return h('div', { className: 'ppt-modal-backdrop ppt-cupertino-backdrop', onClick: () => !busy && c.$docModalOpen.set(false) },
      h('div', { className: 'ppt-modal ppt-doc-modal ppt-cupertino-sheet ppt-outline-modal-sheet', onClick: e => e.stopPropagation() },
        h('div', { className: 'ppt-modal-header ppt-cupertino-sheet-header' },
          h('div', { className: 'ppt-header-text-group' },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { className: 'ppt-apple-badge' }, 'Step 2 / 2'),
              h('h3', { className: 'ppt-modal-title' }, `📑 确认演示文稿大纲 (${outlineData.slides.length} 页)`)
            ),
            h('p', { className: 'ppt-muted', style: { margin: '4px 0 0' } }, outlineData.summary || '确认或调整每页标题、匹配版式与核心要点，点击确认即可生成高质量成稿')
          ),
          h('button', {
            className: 'ppt-cupertino-close-btn',
            'aria-label': '关闭',
            disabled: !!busy,
            onClick: () => !busy && c.$docModalOpen.set(false)
          }, '✕')
        ),
        h('div', { className: 'ppt-modal-body ppt-cupertino-sheet-body' },
          h('div', { className: 'ppt-form-row' },
            h('label', { className: 'ppt-field-label' }, '文稿总标题'),
            h('input', {
              className: 'ppt-input ppt-cupertino-input',
              value: outlineData.title,
              disabled: !!busy,
              onChange: e => setOutlineData({ ...outlineData, title: e.target.value })
            })
          ),
          h('div', { className: 'ppt-outline-cards-list' },
            outlineData.slides.map((s, idx) => h('div', { key: idx, className: 'ppt-outline-card ppt-cupertino-card' },
              h('div', { className: 'ppt-outline-slide-header' },
                h('span', { className: 'ppt-outline-index-badge' }, `第 ${idx + 1} 页`),
                h('select', {
                  className: 'ppt-input ppt-cupertino-input ppt-outline-layout-select',
                  value: s.layout_id,
                  disabled: !!busy,
                  onChange: e => {
                    const newSlides = [...outlineData.slides]
                    newSlides[idx] = { ...s, layout_id: e.target.value }
                    setOutlineData({ ...outlineData, slides: newSlides })
                  }
                },
                  LAYOUTS.map(l => h('option', { key: l.id, value: l.id }, `${l.id} · ${l.name}`))
                ),
                h('div', { className: 'ppt-outline-actions' },
                  h('button', {
                    type: 'button',
                    disabled: idx === 0 || !!busy,
                    onClick: () => {
                      const newSlides = [...outlineData.slides]
                      const temp = newSlides[idx]
                      newSlides[idx] = newSlides[idx - 1]
                      newSlides[idx - 1] = temp
                      setOutlineData({ ...outlineData, slides: newSlides })
                    }
                  }, '↑'),
                  h('button', {
                    type: 'button',
                    disabled: idx === outlineData.slides.length - 1 || !!busy,
                    onClick: () => {
                      const newSlides = [...outlineData.slides]
                      const temp = newSlides[idx]
                      newSlides[idx] = newSlides[idx + 1]
                      newSlides[idx + 1] = temp
                      setOutlineData({ ...outlineData, slides: newSlides })
                    }
                  }, '↓'),
                  h('button', {
                    type: 'button',
                    className: 'ppt-outline-delete-btn',
                    disabled: outlineData.slides.length <= 1 || !!busy,
                    onClick: () => {
                      const newSlides = outlineData.slides.filter((_, i) => i !== idx)
                      setOutlineData({ ...outlineData, slides: newSlides })
                    }
                  }, '🗑️')
                )
              ),
              h('input', {
                className: 'ppt-input ppt-cupertino-input ppt-outline-title-input',
                value: s.title,
                disabled: !!busy,
                placeholder: '输入本页标题主旨…',
                onChange: e => {
                  const newSlides = [...outlineData.slides]
                  newSlides[idx] = { ...s, title: e.target.value }
                  setOutlineData({ ...outlineData, slides: newSlides })
                }
              }),
              h('textarea', {
                className: 'ppt-textarea ppt-cupertino-textarea ppt-outline-bullets-input',
                rows: 3,
                disabled: !!busy,
                value: Array.isArray(s.bullets) ? s.bullets.join('\n') : s.bullets,
                placeholder: '每行一个要点，例如：【核心论点】具体说明事实与数据…',
                onChange: e => {
                  const newSlides = [...outlineData.slides]
                  newSlides[idx] = { ...s, bullets: e.target.value.split('\n') }
                  setOutlineData({ ...outlineData, slides: newSlides })
                }
              })
            ))
          ),
          h('button', {
            type: 'button',
            className: 'ppt-apple-btn-secondary ppt-add-outline-btn',
            disabled: !!busy,
            onClick: () => {
              setOutlineData({
                ...outlineData,
                slides: [...outlineData.slides, { title: '新页面标题', layout_id: 'L003', bullets: ['【核心论点】补充业务事实与规划'] }]
              })
            }
          }, '➕ 添加单页大纲')
        ),
        h('div', { className: 'ppt-modal-footer ppt-cupertino-sheet-footer' },
          h('button', {
            type: 'button',
            className: 'ppt-apple-btn-secondary',
            disabled: !!busy,
            onClick: () => setStep('input')
          }, '← 返回修改原文'),
          h('button', {
            type: 'button',
            className: 'ppt-apple-btn-primary',
            disabled: !!busy,
            onClick: handleConfirmOutline
          }, busy ? '正在生成全篇文稿…' : '✨ 确认大纲，生成完整文稿')
        )
      )
    )
  }

  return h('div', { className: 'ppt-modal-backdrop ppt-cupertino-backdrop', onClick: () => !busy && c.$docModalOpen.set(false) },
    h('div', { className: 'ppt-modal ppt-doc-modal ppt-cupertino-sheet', onClick: e => e.stopPropagation() },
      h('div', { className: 'ppt-modal-header ppt-cupertino-sheet-header' },
        h('div', { className: 'ppt-header-text-group' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { className: 'ppt-apple-badge' }, 'Doc-to-Deck'),
            h('h3', { className: 'ppt-modal-title' }, '📄 文档一键转 PPT (Doc-to-Deck)')
          ),
          h('p', { className: 'ppt-muted', style: { margin: '4px 0 0' } }, '粘贴 Markdown、会议纪要、PRD或技术报告，AI将智能提炼并自适应匹配专业版式')
        ),
        h('button', {
          className: 'ppt-cupertino-close-btn',
          'aria-label': '关闭',
          disabled: !!busy,
          onClick: () => !busy && c.$docModalOpen.set(false)
        }, '✕')
      ),
      h('div', { className: 'ppt-modal-body ppt-cupertino-sheet-body' },
        h('div', { className: 'ppt-presets-bar' },
          h('span', { className: 'ppt-presets-label' }, '快捷示范：'),
          DOC_PRESETS.map((p, idx) => h('button', {
            key: idx,
            type: 'button',
            className: 'ppt-preset-chip',
            disabled: !!busy,
            onClick: () => {
              setTitle(p.title)
              setDocText(p.text)
            }
          }, p.label)),
          h('label', { className: 'ppt-preset-chip ppt-upload-chip', title: '从本地加载 Markdown 或 TXT 纯文本' },
            h('span', null, '📂 导入文件 (.md/.txt)'),
            h('input', {
              type: 'file',
              accept: '.md,.markdown,.txt',
              style: { display: 'none' },
              disabled: !!busy,
              onChange: handleFileImport
            })
          )
        ),
        h('div', { className: 'ppt-form-row' },
          h('label', { className: 'ppt-field-label' }, '文稿标题（选填，留空将由 AI 自动提炼）'),
          h('input', {
            className: 'ppt-input ppt-cupertino-input',
            placeholder: '例如：2024 年度产品战略规划与技术架构',
            value: title,
            disabled: !!busy,
            onChange: e => setTitle(e.target.value)
          })
        ),
        h('div', { className: 'ppt-form-row' },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 } },
            h('label', { className: 'ppt-field-label', style: { margin: 0 } }, '文档正文内容或大纲 *'),
            h('span', { className: `ppt-char-counter ${isTextValid ? 'ppt-char-counter-valid' : ''}` },
              isTextValid ? `✓ 已输入 ${charCount} 字` : `${charCount} / 最少 5 字`
            )
          ),
          h('textarea', {
            className: 'ppt-textarea ppt-cupertino-textarea',
            rows: 7,
            placeholder: '在此粘贴 Markdown 长文、需求文档、总结汇报或提纲…\n\n示例：\n# 核心项目复盘\n## 背景与业务痛点\n- 现有系统延迟高、资源开销大\n## 实施成果\n- 架构完成全量重构，SLA提升至99.99%',
            value: docText,
            disabled: !!busy,
            onChange: e => setDocText(e.target.value)
          })
        ),
        h('div', { className: 'ppt-form-row' },
          h('label', { className: 'ppt-field-label' }, '主题风格'),
          h(SegmentedControl, {
            value: theme,
            onChange: setTheme,
            disabled: !!busy,
            options: [
              { label: '💼 商务深蓝', value: 'business' },
              { label: '⚡ 暗夜科技', value: 'technology' },
              { label: '🌿 极简雅致', value: 'minimal' },
              { label: '🍎 活力果红', value: 'crimson' },
              { label: '👑 尊贵雅致', value: 'royal' },
              { label: '🍸 香槟轻奢', value: 'elegant' },
            ]
          })
        ),
        h('div', { className: 'ppt-form-grid-2col' },
          h('div', { className: 'ppt-form-col' },
            h('label', { className: 'ppt-field-label' }, '目标页数'),
            h(SegmentedControl, {
              value: targetPages,
              onChange: setTargetPages,
              disabled: !!busy,
              options: [
                { label: '5 页 · 精炼', value: 5 },
                { label: '8 页 · 推荐', value: 8 },
                { label: '12 页 · 深度', value: 12 },
                { label: '16 页 · 详实', value: 16 }
              ]
            })
          ),
          h('div', { className: 'ppt-form-col' },
            h('label', { className: 'ppt-field-label' }, '画面比例'),
            h(SegmentedControl, {
              value: ratio,
              onChange: setRatio,
              disabled: !!busy,
              options: [
                { label: '16:9 宽屏', value: '16:9' },
                { label: '4:3 经典', value: '4:3' }
              ]
            })
          )
        )
      ),
      h('div', { className: 'ppt-modal-footer ppt-cupertino-sheet-footer' },
        h('button', {
          type: 'button',
          className: 'ppt-apple-btn-secondary',
          disabled: !!busy,
          onClick: () => c.$docModalOpen.set(false)
        }, '取消'),
        h('button', {
          type: 'button',
          className: 'ppt-apple-btn-secondary',
          disabled: !!busy || !docText.trim(),
          onClick: handleConvert
        }, busy ? '正在智能转换中…' : '开始智能转换'),
        h('button', {
          type: 'button',
          className: 'ppt-apple-btn-primary',
          disabled: !!busy || !docText.trim(),
          onClick: handleGenerateOutline
        }, busy ? '正在智能规划中…' : '📑 先规划大纲并预览 (推荐)')
      )
    )
  )
}

function DeleteProjectModal({ c }) {
  const open = useValue(c.$deleteModalOpen), busy = useValue(c.$busy), doc = useValue(c.$doc)
  if (!open || !doc) return null
  const deck = doc.deck

  return h('div', {
    className: 'ppt-modal-backdrop ppt-cupertino-backdrop',
    onClick: () => !busy && c.$deleteModalOpen.set(false)
  },
    h('div', {
      className: 'ppt-modal ppt-delete-modal ppt-cupertino-sheet',
      onClick: e => e.stopPropagation()
    },
      h('div', { className: 'ppt-modal-header ppt-cupertino-sheet-header' },
        h('div', { className: 'ppt-header-text-group' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { className: 'ppt-apple-badge ppt-badge-danger' }, '危险操作'),
            h('h3', { className: 'ppt-modal-title' }, '🗑️ 删除演示文稿')
          ),
          h('p', { className: 'ppt-muted', style: { margin: '4px 0 0' } }, '文稿一经删除将无法恢复，请确认是否继续')
        ),
        h('button', {
          type: 'button',
          className: 'ppt-cupertino-close-btn',
          'aria-label': '关闭',
          disabled: !!busy,
          onClick: () => !busy && c.$deleteModalOpen.set(false)
        }, '✕')
      ),
      h('div', { className: 'ppt-modal-body ppt-cupertino-sheet-body' },
        h('div', { className: 'ppt-delete-info-card' },
          h('div', { className: 'ppt-delete-info-row' },
            h('span', { className: 'ppt-muted' }, '文稿名称：'),
            h('strong', { className: 'ppt-delete-info-title' }, deck.name)
          ),
          h('div', { className: 'ppt-delete-info-row' },
            h('span', { className: 'ppt-muted' }, '页面数量：'),
            h('span', null, `${deck.slides.length} 页幻灯片`)
          ),
          h('div', { className: 'ppt-delete-info-row' },
            h('span', { className: 'ppt-muted' }, '当前版本：'),
            h('span', null, `v${doc.revision}`)
          )
        ),
        h('div', { className: 'ppt-delete-warning-box' },
          h('span', { className: 'ppt-delete-warning-icon' }, '⚠️'),
          h('div', { className: 'ppt-delete-warning-text' },
            h('strong', null, '提示：'),
            h('span', null, '此操作将永久清空该文稿的所有页面、元素样式、历史记录和快照，不可撤销。')
          )
        )
      ),
      h('div', { className: 'ppt-modal-footer ppt-cupertino-sheet-footer' },
        h('button', {
          type: 'button',
          className: 'ppt-apple-btn-secondary',
          disabled: !!busy,
          onClick: () => c.$deleteModalOpen.set(false)
        }, '取消'),
        h('button', {
          type: 'button',
          className: 'ppt-apple-btn-danger',
          disabled: !!busy,
          onClick: () => c.delete(deck.id)
        }, busy ? '正在删除…' : '确认删除文稿')
      )
    )
  )
}

const IMAGE_PROMPT_PRESETS = [
  { label: '☁️ 云原生架构', prompt: '现代化云原生高可用微服务架构概念图，数据流转与容器集群' },
  { label: '🚀 战略增长飞轮', prompt: '企业商业战略增长飞轮与数字化推进矩阵示意图，科技极简' },
  { label: '📊 数据资产大屏', prompt: '全景大数据分析仪表盘与量化监控大屏概念图，发光科技质感' },
  { label: '🛡️ 企业数字安全', prompt: '企业级零信任数字安全与分布式加密防护盾牌概念插画' },
  { label: '🤝 组织敏捷协同', prompt: '多团队敏捷协同与数字孪生项目全流程协作场景插画' },
]

function ImageGenModal({ c }) {
  const open = useValue(c.$imageModalOpen), busy = useValue(c.$busy)
  const doc = useValue(c.$doc), slideId = useValue(c.$slide)
  const targetElementId = useValue(c.$imageModalTargetElement)
  const [prompt, setPrompt] = useState('')
  const [style, setStyle] = useState('illustration')
  const [aspectRatio, setAspectRatio] = useState('landscape')

  if (!open) return null

  const currentSlide = doc?.deck?.slides?.find(s => s.id === slideId)
  const allElements = currentSlide ? flatten(currentSlide.elements || []) : []
  const targetElem = targetElementId ? allElements.find(e => e.id === targetElementId) : null

  const handleExtractFromSlide = () => {
    if (!currentSlide) return
    const title = currentSlide.name || ''
    const bodyText = currentSlide.elements?.find(e => e.role === 'body' || e.kind === 'text')?.text || ''
    const cleanBody = bodyText.split('\n')[0]?.replace(/[•\-*]/g, '').trim() || ''
    const autoPrompt = `${title}${cleanBody ? '：' + cleanBody : ''} 现代商业概念配图，极简专业设计`
    setPrompt(autoPrompt)
  }

  const handleExtractFromElement = () => {
    if (!targetElem) return
    const name = targetElem.name || '元素'
    const textSnippet = targetElem.text ? `：${targetElem.text.split('\n')[0].slice(0, 32)}` : ''
    setPrompt(`${name}${textSnippet} 现代商业概念配图，极简专业设计`)
  }

  const handleGenerate = async () => {
    if (!prompt.trim()) return
    await c.generateImage(prompt.trim(), style, aspectRatio, targetElementId)
  }

  return h('div', { className: 'ppt-modal-backdrop ppt-cupertino-backdrop', onClick: () => !busy && c.$imageModalOpen.set(false) },
    h('div', { className: 'ppt-modal ppt-image-modal ppt-cupertino-sheet', onClick: e => e.stopPropagation() },
      h('div', { className: 'ppt-modal-header ppt-cupertino-sheet-header' },
        h('div', { className: 'ppt-header-text-group' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { className: 'ppt-apple-badge' }, 'AI Visual'),
            h('h3', { className: 'ppt-modal-title' }, targetElementId ? `🎨 为选定元素 ${targetElementId} 生成配图` : '🎨 AI 智能内容配图 (Image Gen)')
          ),
          h('p', { className: 'ppt-muted', style: { margin: '4px 0 0' } }, targetElementId ? `将为选中的元素【${targetElem?.name || targetElementId}】生成专属视觉配图并精准替换` : '根据幻灯片主题或自定描述，AI 实时生成商业级高清配图并自动插入当前页面')
        ),
        h('button', {
          type: 'button',
          className: 'ppt-cupertino-close-btn',
          'aria-label': '关闭',
          disabled: !!busy,
          onClick: () => !busy && c.$imageModalOpen.set(false)
        }, '✕')
      ),
      h('div', { className: 'ppt-modal-body ppt-cupertino-sheet-body' },
        targetElementId && h('div', { className: 'ppt-ai-extract-card ppt-target-element-card' },
          h('div', { className: 'ppt-ai-extract-header' },
            h('span', { className: 'ppt-muted', style: { fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 6 } },
              h('span', { className: 'ppt-apple-badge' }, 'Target Element'),
              `已选定目标元素：${targetElementId}${targetElem?.name ? ' · ' + targetElem.name : ''}`
            ),
            h('button', {
              type: 'button',
              className: 'ppt-auto-prompt-btn',
              disabled: !!busy,
              onClick: handleExtractFromElement
            }, '🪄 提取元素主旨')
          )
        ),
        currentSlide && !targetElementId && h('div', { className: 'ppt-ai-extract-card' },
          h('div', { className: 'ppt-ai-extract-header' },
            h('span', { className: 'ppt-muted', style: { fontSize: 11.5 } }, `当前页面：${currentSlide.id} · ${currentSlide.name}`),
            h('button', {
              type: 'button',
              className: 'ppt-auto-prompt-btn',
              disabled: !!busy,
              onClick: handleExtractFromSlide
            }, '🪄 从本页提取主旨')
          )
        ),
        h('div', { className: 'ppt-presets-bar' },
          h('span', { className: 'ppt-presets-label' }, '快捷灵感：'),
          IMAGE_PROMPT_PRESETS.map((p, idx) => h('button', {
            key: idx,
            type: 'button',
            className: 'ppt-preset-chip',
            disabled: !!busy,
            onClick: () => setPrompt(p.prompt)
          }, p.label))
        ),
        h('div', { className: 'ppt-form-row' },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 } },
            h('label', { className: 'ppt-field-label', style: { margin: 0 } }, '配图画面描述词 (Prompt) *'),
            h('span', { className: 'ppt-char-counter' }, `${prompt.trim().length} 字`)
          ),
          h('textarea', {
            className: 'ppt-textarea ppt-cupertino-textarea',
            rows: 4,
            placeholder: '例如：云原生高可用微服务架构示意图，深蓝色科技渐变背景，极简矢量图表…',
            value: prompt,
            disabled: !!busy,
            onChange: e => setPrompt(e.target.value)
          })
        ),
        h('div', { className: 'ppt-form-grid-2col' },
          h('div', { className: 'ppt-form-col' },
            h('label', { className: 'ppt-field-label' }, '视觉风格 (Style)'),
            h(SegmentedControl, {
              value: style,
              onChange: setStyle,
              disabled: !!busy,
              options: [
                { label: '🎨 扁平插画', value: 'illustration' },
                { label: '⚡ 科技深色', value: 'tech' },
                { label: '🧊 3D立体', value: '3d' },
                { label: '📷 商业摄影', value: 'photo' },
              ]
            })
          ),
          h('div', { className: 'ppt-form-col' },
            h('label', { className: 'ppt-field-label' }, '画面比例 (Aspect Ratio)'),
            h(SegmentedControl, {
              value: aspectRatio,
              onChange: setAspectRatio,
              disabled: !!busy,
              options: [
                { label: '16:9 宽屏', value: 'landscape' },
                { label: '1:1 正方', value: 'square' },
                { label: '3:4 纵向', value: 'portrait' },
              ]
            })
          )
        )
      ),
      h('div', { className: 'ppt-modal-footer ppt-cupertino-sheet-footer' },
        h('span', { className: 'ppt-muted', style: { marginRight: 'auto', fontSize: 11 } }, '支持 DALL-E / Fal / 离线矢量图形引擎自适应生成'),
        h('button', {
          type: 'button',
          className: 'ppt-apple-btn-secondary',
          disabled: !!busy,
          onClick: () => c.$imageModalOpen.set(false)
        }, '取消'),
        h('button', {
          type: 'button',
          className: 'ppt-apple-btn-primary',
          disabled: !!busy || !prompt.trim(),
          onClick: handleGenerate
        }, busy ? '正在生成高清配图…' : (targetElementId ? '🎨 为选定元素生成并替换' : '🎨 立即生成并插入'))
      )
    )
  )
}


function PresentationView({ c }) {
  const doc = useValue(c.$doc)
  const presenting = useValue(c.$presenting)
  const currentSlideId = useValue(c.$slide)
  const laserActive = useValue(c.$laserActive)
  const showNotes = useValue(c.$presenterNotesOpen)
  const blackout = useValue(c.$blackout)
  const [laserPos, setLaserPos] = useState({ x: -100, y: -100 })
  const [controlsVisible, setControlsVisible] = useState(true)
  const hideTimerRef = useRef(null)

  const slides = doc?.deck?.slides || []
  const currentIndex = Math.max(0, slides.findIndex(s => s.id === currentSlideId))
  const currentSlide = slides[currentIndex] || slides[0]

  const view = useView(c, doc, currentSlide?.id, false, presenting && !!doc)

  const goToSlide = index => {
    if (index >= 0 && index < slides.length) {
      c.$slide.set(slides[index].id)
      c.$selection.set([])
    }
  }

  const nextSlide = () => goToSlide(currentIndex + 1)
  const prevSlide = () => goToSlide(currentIndex - 1)
  const exitPresentation = () => {
    c.$presenting.set(false)
    c.$blackout.set(false)
    c.$laserActive.set(false)
    c.$presenterNotesOpen.set(false)
  }

  const handlePointerMove = e => {
    if (laserActive) {
      setLaserPos({ x: e.clientX, y: e.clientY })
    }
    setControlsVisible(true)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => {
      setControlsVisible(false)
    }, 3000)
  }

  useEffect(() => {
    const handleKeyDown = e => {
      if (!c.$presenting.get()) return
      if (e.key === 'Escape') {
        e.preventDefault()
        exitPresentation()
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ' || e.key === 'PageDown' || e.key === 'Enter') {
        e.preventDefault()
        nextSlide()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Backspace') {
        e.preventDefault()
        prevSlide()
      } else if (e.key === 'b' || e.key === 'B' || e.key === '.') {
        e.preventDefault()
        c.$blackout.set(!c.$blackout.get())
      } else if (e.key === 'l' || e.key === 'L') {
        e.preventDefault()
        c.$laserActive.set(!c.$laserActive.get())
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        c.$presenterNotesOpen.set(!c.$presenterNotesOpen.get())
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [currentIndex, slides.length])

  if (!presenting || !doc) return null

  return h('div', {
    className: `ppt-presentation-overlay ${laserActive ? 'ppt-laser-cursor' : ''}`,
    onPointerMove: handlePointerMove,
    onClick: () => {
      if (blackout) c.$blackout.set(false)
    }
  },
    blackout ? h('div', { className: 'ppt-presentation-blackout' },
      h('span', { className: 'ppt-blackout-hint' }, '已开启黑屏 (按 B 键或点击屏幕任意处恢复)')
    ) : h('div', { className: 'ppt-presentation-stage' },
      view.data?.svg ? h('div', {
        className: 'ppt-presentation-svg-wrapper',
        dangerouslySetInnerHTML: { __html: view.data.svg }
      }) : h('div', { className: 'ppt-presentation-loading' },
        h(GlyphSpinner),
        h('span', null, '正在准备全屏页面…')
      )
    ),

    laserActive && !blackout && h('div', {
      className: 'ppt-laser-pointer-dot',
      style: { left: laserPos.x, top: laserPos.y }
    }),

    showNotes && !blackout && h('aside', { className: 'ppt-presentation-notes-hud' },
      h('div', { className: 'ppt-notes-hud-header' },
        h('span', { className: 'ppt-notes-hud-title' }, `🎙️ 演讲备忘 · ${currentSlide.id} ${currentSlide.name}`),
        h('button', { className: 'ppt-notes-hud-close', onClick: () => c.$presenterNotesOpen.set(false) }, '✕')
      ),
      h('div', { className: 'ppt-notes-hud-body' },
        currentSlide.notes ? h('p', null, currentSlide.notes) : h('p', { className: 'ppt-notes-empty' }, '本页暂无演讲备忘（在编辑界面点击【✨ AI 生成讲稿】即可自动编写）')
      )
    ),

    h('nav', {
      className: `ppt-presentation-hud ${controlsVisible ? 'ppt-hud-visible' : 'ppt-hud-hidden'}`
    },
      h('button', {
        className: 'ppt-hud-btn',
        disabled: currentIndex === 0,
        onClick: prevSlide,
        'aria-label': '上一页'
      }, '◀'),
      h('div', { className: 'ppt-hud-counter' },
        h('span', { className: 'ppt-hud-index' }, `${currentSlide.id} · ${currentIndex + 1}`),
        h('span', { className: 'ppt-hud-total' }, ` / ${slides.length}`)
      ),
      h('button', {
        className: 'ppt-hud-btn',
        disabled: currentIndex === slides.length - 1,
        onClick: nextSlide,
        'aria-label': '下一页'
      }, '▶'),
      h('span', { className: 'ppt-hud-divider' }),
      h('button', {
        className: `ppt-hud-btn ppt-hud-toggle ${laserActive ? 'ppt-hud-active' : ''}`,
        onClick: () => c.$laserActive.set(!laserActive),
        title: '激光笔 (快捷键 L)'
      }, '🔴 激光笔'),
      h('button', {
        className: `ppt-hud-btn ppt-hud-toggle ${showNotes ? 'ppt-hud-active' : ''}`,
        onClick: () => c.$presenterNotesOpen.set(!showNotes),
        title: '演讲备忘 (快捷键 N)'
      }, '🎙️ 备忘'),
      h('button', {
        className: `ppt-hud-btn ppt-hud-toggle ${blackout ? 'ppt-hud-active' : ''}`,
        onClick: () => c.$blackout.set(!blackout),
        title: '黑屏暂停 (快捷键 B)'
      }, '⬛ 黑屏'),
      h('span', { className: 'ppt-hud-divider' }),
      h('button', {
        className: 'ppt-hud-btn ppt-hud-exit',
        onClick: exitPresentation,
        title: '退出放映 (快捷键 Esc)'
      }, '✕ 退出')
    )
  )
}


function ExportModal({ c }) {
  const doc = useValue(c.$doc)
  const open = useValue(c.$exportModalOpen)
  const busy = useValue(c.$busy)
  const slideId = useValue(c.$slide)

  if (!open || !doc) return null

  const currentSlide = doc.deck.slides.find(s => s.id === slideId) || doc.deck.slides[0]

  return h('div', { className: 'ppt-modal-backdrop', onClick: () => c.$exportModalOpen.set(false) },
    h('div', { className: 'ppt-modal-sheet ppt-export-modal-sheet', onClick: e => e.stopPropagation() },
      h('div', { className: 'ppt-modal-sheet-header' },
        h('div', null,
          h('h2', { className: 'ppt-sheet-title' }, '导出与分享演示文稿'),
          h('p', { className: 'ppt-sheet-subtitle' }, '支持 Office 原生排版、高清打印矢量 PDF、以及适合微信/飞书分享的长图')
        ),
        h('button', { className: 'ppt-sheet-close', onClick: () => c.$exportModalOpen.set(false) }, '✕')
      ),
      h('div', { className: 'ppt-export-grid' },
        h('div', {
          className: 'ppt-export-card',
          onClick: () => !busy && c.exportPptx()
        },
          h('div', { className: 'ppt-export-card-icon', style: { background: 'rgba(216, 59, 1, 0.12)', color: '#d83b01' } }, '💼'),
          h('div', { className: 'ppt-export-card-info' },
            h('div', { className: 'ppt-export-card-title' }, 'PowerPoint 演示文稿 (.pptx)'),
            h('p', { className: 'ppt-export-card-desc' }, '原生可编辑对象、矢量形状、原生嵌入图表与幻灯片母版，支持在 Office / WPS 中深度二次排版。'),
            h('span', { className: 'ppt-export-badge' }, '标准格式 · 原生可编辑')
          )
        ),

        h('div', {
          className: 'ppt-export-card',
          onClick: () => !busy && c.exportPdf()
        },
          h('div', { className: 'ppt-export-card-icon', style: { background: 'rgba(255, 59, 48, 0.12)', color: '#ff3b30' } }, '📑'),
          h('div', { className: 'ppt-export-card-info' },
            h('div', { className: 'ppt-export-card-title' }, '矢量 PDF 文档 (.pdf)'),
            h('p', { className: 'ppt-export-card-desc' }, '高保真矢量打印排版，字体排版无损缩放，适合商务汇报归档、邮件附件发送及跨平台查阅。'),
            h('span', { className: 'ppt-export-badge' }, '高保真 · 矢量打印')
          )
        ),

        h('div', {
          className: 'ppt-export-card',
          onClick: () => !busy && c.exportLongImage()
        },
          h('div', { className: 'ppt-export-card-icon', style: { background: 'rgba(0, 113, 227, 0.12)', color: '#0071e3' } }, '📱'),
          h('div', { className: 'ppt-export-card-info' },
            h('div', { className: 'ppt-export-card-title' }, '全篇高清长图海报 (.png)'),
            h('p', { className: 'ppt-export-card-desc' }, '将全篇幻灯片串联渲染为单张高清长图，带有页面标题与页码标牌，非常适合在微信、飞书、企业微信群直接分享与手机滑动浏览。'),
            h('span', { className: 'ppt-export-badge' }, '微信/飞书分享神器')
          )
        ),

        h('div', {
          className: 'ppt-export-card',
          onClick: () => !busy && c.exportSlideImage(currentSlide.id)
        },
          h('div', { className: 'ppt-export-card-icon', style: { background: 'rgba(52, 199, 89, 0.12)', color: '#34c759' } }, '🖼️'),
          h('div', { className: 'ppt-export-card-info' },
            h('div', { className: 'ppt-export-card-title' }, `当前页高清图 (${currentSlide.id} · .png)`),
            h('p', { className: 'ppt-export-card-desc' }, `导出第 ${doc.deck.slides.findIndex(s => s.id === currentSlide.id) + 1} 页《${currentSlide.name}》的超清图片，用于单独插图或封面海报。`),
            h('span', { className: 'ppt-export-badge' }, '1080P/4K 单页图')
          )
        ),

        h('div', {
          className: 'ppt-export-card',
          onClick: () => !busy && c.exportProject()
        },
          h('div', { className: 'ppt-export-card-icon', style: { background: 'rgba(175, 82, 222, 0.12)', color: '#af52de' } }, '📦'),
          h('div', { className: 'ppt-export-card-info' },
            h('div', { className: 'ppt-export-card-title' }, '项目工程包 (.forxppt)'),
            h('p', { className: 'ppt-export-card-desc' }, '包含所有版本历史分支、母版样式、对象编号及原始素材的工程备份，随时随地一键导入恢复。'),
            h('span', { className: 'ppt-export-badge' }, '完整工程备份')
          )
        )
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
      doc && h('div', { className: 'ppt-pages-header-actions' },
        h('span', { className: 'ppt-pill-badge' }, `${doc.deck.slides.length} 页`),
        h('button', {
          type: 'button',
          className: 'ppt-icon-btn-danger',
          title: '删除当前文稿',
          'aria-label': '删除当前文稿',
          disabled: !!c.$busy.get(),
          onClick: () => c.$deleteModalOpen.set(true)
        }, '🗑️')
      )
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
  const canvasRef = useRef(null)
  const [dragState, setDragState] = useState(null)
  const [inlineEditing, setInlineEditing] = useState(null)

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

  const handlePointerDown = (event, type, targetEl) => {
    event.stopPropagation()
    event.preventDefault()
    const wrapper = canvasRef.current
    if (!wrapper) return
    const rect = wrapper.getBoundingClientRect()
    const startClientX = event.clientX
    const startClientY = event.clientY
    const startBox = { ...targetEl.box }
    const scale = (doc.deck.width * 72) / rect.width

    let latestBox = { ...startBox }
    let guideX = null, guideY = null

    const onPointerMove = (e) => {
      const dxPts = (e.clientX - startClientX) * scale
      const dyPts = (e.clientY - startClientY) * scale
      const dxInches = dxPts / 72
      const dyInches = dyPts / 72

      let newX = startBox.x
      let newY = startBox.y
      let newW = startBox.width
      let newH = startBox.height

      if (type === 'move') {
        newX = startBox.x + dxInches
        newY = startBox.y + dyInches
      } else {
        if (type.includes('w')) {
          const maxDeltaW = startBox.width - 0.4
          const actualDx = Math.min(maxDeltaW, dxInches)
          newX = startBox.x + actualDx
          newW = startBox.width - actualDx
        }
        if (type.includes('e')) {
          newW = Math.max(0.4, startBox.width + dxInches)
        }
        if (type.includes('n')) {
          const maxDeltaH = startBox.height - 0.25
          const actualDy = Math.min(maxDeltaH, dyInches)
          newY = startBox.y + actualDy
          newH = startBox.height - actualDy
        }
        if (type.includes('s')) {
          newH = Math.max(0.25, startBox.height + dyInches)
        }
      }

      guideX = null
      guideY = null
      const snapThreshold = 0.15
      if (type === 'move') {
        if (Math.abs((newX + newW / 2) - (doc.deck.width / 2)) < snapThreshold) {
          newX = doc.deck.width / 2 - newW / 2
          guideX = (doc.deck.width / 2) * 72
        } else if (Math.abs(newX - 0.6) < snapThreshold) {
          newX = 0.6
          guideX = 0.6 * 72
        } else if (Math.abs((newX + newW) - (doc.deck.width - 0.6)) < snapThreshold) {
          newX = doc.deck.width - 0.6 - newW
          guideX = (doc.deck.width - 0.6) * 72
        }

        if (Math.abs((newY + newH / 2) - (doc.deck.height / 2)) < snapThreshold) {
          newY = doc.deck.height / 2 - newH / 2
          guideY = (doc.deck.height / 2) * 72
        }
      }

      newX = Math.max(0, Math.min(doc.deck.width - 0.4, newX))
      newY = Math.max(0, Math.min(doc.deck.height - 0.25, newY))
      newW = Math.max(0.4, Math.min(doc.deck.width - newX, newW))
      newH = Math.max(0.25, Math.min(doc.deck.height - newY, newH))

      latestBox = {
        x: Math.round(newX * 1000) / 1000,
        y: Math.round(newY * 1000) / 1000,
        width: Math.round(newW * 1000) / 1000,
        height: Math.round(newH * 1000) / 1000
      }

      setDragState({
        id: targetEl.id,
        box: latestBox,
        guideX,
        guideY
      })
    }

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      setDragState(null)
      if (latestBox.x !== startBox.x || latestBox.y !== startBox.y || latestBox.width !== startBox.width || latestBox.height !== startBox.height) {
        c.edit([{
          action: 'update_element',
          target: targetEl.id,
          slide_id: targetEl.origin === 'M001' ? undefined : slideId,
          changes: { box: latestBox }
        }], '调整元素位置与大小')
      }
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  const commitInlineEdit = () => {
    if (!inlineEditing) return
    const currentSlide = doc.deck.slides.find(s => s.id === slideId)
    const slideElems = currentSlide ? flatten(currentSlide.elements || []) : []
    const masterElems = flatten(doc.deck.master.elements || [])
    const match = [...slideElems, ...masterElems].find(elem => elem.id === inlineEditing.id)
    if (match && inlineEditing.text !== match.text) {
      c.edit([{
        action: 'update_element',
        target: inlineEditing.id,
        slide_id: match.source === 'M001' ? undefined : slideId,
        changes: { text: inlineEditing.text }
      }], '编辑文字')
    }
    setInlineEditing(null)
  }

  return h('main', { className: 'ppt-canvas-area' },
    h('div', { className: 'ppt-stage-header' },
      h('div', { className: 'ppt-stage-title' },
        h('span', { className: 'ppt-pill-badge' }, slideId),
        h('span', { className: 'ppt-stage-slide-name' }, doc.deck.slides.find(s => s.id === slideId)?.name || '当前幻灯片'),
        h('select', {
          className: 'ppt-layout-select',
          'aria-label': '页面版式',
          value: doc.deck.slides.find(s => s.id === slideId)?.layout_id || 'L003',
          onChange: event => void c.relayoutSlide(event.target.value)
        },
          LAYOUTS.map(l => h('option', { key: l.id, value: l.id }, `${l.id} · ${l.name}`))
        ),
        button('✨ 智能重构', () => c.$reLayoutModalOpen.set(true), !!c.$busy.get(), { className: 'ppt-relayout-btn' })
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
      h('div', {
        ref: canvasRef,
        className: 'ppt-canvas ppt-canvas-wrapper',
        style: { aspectRatio: `${doc.deck.width}/${doc.deck.height}` },
        onClick: event => {
          if (showingBefore || dragState) return
          const id = event.target.closest?.('[data-element-id]')?.dataset.elementId
          const current = c.$selection.get()
          const next = id ? (event.ctrlKey || event.metaKey ? (current.includes(id) ? current.filter(v => v !== id) : [...current, id]) : [id]) : []
          c.$selection.set(next)
          if (next.length > 0) {
            c.$rightOpen.set(true)
          }
        }
      },
        svg ? h('div', { className: 'ppt-svg', dangerouslySetInnerHTML: { __html: svg } }) : h('p', { role: view.error ? 'alert' : 'status', style: { padding: 32 } }, view.error?.message || '正在更新预览…'),
        inlineEditing && h('div', {
          className: 'ppt-inline-edit-overlay',
          style: {
            position: 'absolute',
            left: `${(inlineEditing.box.x / doc.deck.width) * 100}%`,
            top: `${(inlineEditing.box.y / doc.deck.height) * 100}%`,
            width: `${(inlineEditing.box.width / doc.deck.width) * 100}%`,
            height: `${(inlineEditing.box.height / doc.deck.height) * 100}%`,
            zIndex: 25,
          }
        },
          h('textarea', {
            className: 'ppt-inline-textarea',
            autoFocus: true,
            value: inlineEditing.text,
            placeholder: '输入文字，Ctrl+Enter 保存，Esc 取消',
            onChange: ev => setInlineEditing({ ...inlineEditing, text: ev.target.value }),
            onKeyDown: ev => {
              if (ev.key === 'Escape') {
                ev.stopPropagation()
                setInlineEditing(null)
              } else if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
                ev.preventDefault()
                commitInlineEdit()
              }
            },
            onBlur: () => commitInlineEdit()
          })
        ),
        !showingBefore && !!boxes.length && h('svg', {
          className: 'ppt-selection',
          viewBox: `0 0 ${doc.deck.width * 72} ${doc.deck.height * 72}`
        },
          dragState?.guideX !== null && dragState?.guideX !== undefined && h('line', {
            key: 'guide-x',
            x1: dragState.guideX, y1: 0, x2: dragState.guideX, y2: doc.deck.height * 72,
            stroke: '#0071e3', strokeWidth: 1.5, strokeDasharray: '4 3'
          }),
          dragState?.guideY !== null && dragState?.guideY !== undefined && h('line', {
            key: 'guide-y',
            x1: 0, y1: dragState.guideY, x2: doc.deck.width * 72, y2: dragState.guideY,
            stroke: '#0071e3', strokeWidth: 1.5, strokeDasharray: '4 3'
          }),
          ...boxes.map(e => {
            const isSingle = boxes.length === 1
            const b = (dragState && dragState.id === e.id) ? dragState.box : e.box
            const bx = b.x * 72, by = b.y * 72, bw = b.width * 72, bh = b.height * 72

            if (!isSingle) {
              return h('rect', {
                key: e.id,
                x: bx, y: by, width: bw, height: bh,
                fill: 'none',
                stroke: 'var(--ui-accent)',
                strokeWidth: 2,
                strokeDasharray: '6 3'
              })
            }

            const handles = [
              { type: 'nw', x: bx, y: by, cursor: 'nwse-resize' },
              { type: 'n', x: bx + bw / 2, y: by, cursor: 'ns-resize' },
              { type: 'ne', x: bx + bw, y: by, cursor: 'nesw-resize' },
              { type: 'e', x: bx + bw, y: by + bh / 2, cursor: 'ew-resize' },
              { type: 'se', x: bx + bw, y: by + bh, cursor: 'nwse-resize' },
              { type: 's', x: bx + bw / 2, y: by + bh, cursor: 'ns-resize' },
              { type: 'sw', x: bx, y: by + bh, cursor: 'nesw-resize' },
              { type: 'w', x: bx, y: by + bh / 2, cursor: 'ew-resize' },
            ]

            return h('g', { key: e.id, className: 'ppt-selection-group' },
              h('rect', {
                x: bx, y: by, width: bw, height: bh,
                fill: 'rgba(0, 113, 227, 0.05)',
                stroke: '#0071e3',
                strokeWidth: 2,
                cursor: 'move',
                pointerEvents: 'all',
                onPointerDown: ev => handlePointerDown(ev, 'move', e),
                onDoubleClick: ev => {
                  ev.stopPropagation()
                  const currentSlide = doc.deck.slides.find(s => s.id === slideId)
                  const slideElems = currentSlide ? flatten(currentSlide.elements || []) : []
                  const masterElems = flatten(doc.deck.master.elements || [])
                  const match = [...slideElems, ...masterElems].find(elem => elem.id === e.id)
                  if (e.kind === 'text' || match?.kind === 'text') {
                    setInlineEditing({ id: e.id, text: match?.text || e.text || '', box: b })
                  }
                }
              }),
              handles.map(hd => h('rect', {
                key: hd.type,
                x: hd.x - 4,
                y: hd.y - 4,
                width: 8,
                height: 8,
                rx: 2,
                fill: '#ffffff',
                stroke: '#0071e3',
                strokeWidth: 1.5,
                cursor: hd.cursor,
                pointerEvents: 'all',
                onPointerDown: ev => handlePointerDown(ev, hd.type, e)
              })),
              dragState && dragState.id === e.id && h('g', { key: 'drag-badge', className: 'ppt-drag-dimension-badge' },
                h('rect', {
                  x: bx + bw / 2 - 40,
                  y: Math.max(2, by - 24),
                  width: 80,
                  height: 18,
                  rx: 4,
                  fill: 'rgba(0, 0, 0, 0.85)'
                }),
                h('text', {
                  x: bx + bw / 2,
                  y: Math.max(2, by - 24) + 12,
                  textAnchor: 'middle',
                  fill: '#ffffff',
                  fontSize: 10,
                  fontWeight: 600
                }, `${b.width.toFixed(2)}" × ${b.height.toFixed(2)}"`)
              )
            )
          })
        )
      )
    ),
    h('div', { className: 'ppt-canvas-footer' },
      h('span', { className: 'ppt-muted' }, '结构预览 · 拖拽边框移动/拉伸句柄缩放 · 双击文字就地编辑'),
      doc.change && h('span', { className: 'ppt-muted' }, `影响 ${doc.change.slides.length} 页、${doc.change.elements.length} 个对象`),
    ),
    ...(doc.issues || []).filter(i => i.slide_id === slideId).map((issue, i) => h('button', { key: i, className: 'ppt-issue', onClick: () => c.$selection.set([issue.element_id]) }, `${issue.element_id}：${issue.message}`)),
  )
}

function Properties({ c, expanded = false }) {
  const doc = useValue(c.$doc), selection = useValue(c.$selection), slideId = useValue(c.$slide), busy = useValue(c.$busy)
  const [search, setSearch] = useState(''), [text, setText] = useState(''), [name, setName] = useState(''), [fontSize, setFontSize] = useState(''), [masterSize, setMasterSize] = useState('32')
  const [notesText, setNotesText] = useState('')
  const upload = useRef(null)
  const slide = doc?.deck.slides.find(s => s.id === slideId)
  const elements = doc ? [...flatten(doc.deck.master.elements).map(e => ({ ...e, source: 'M001' })), ...flatten(slide?.elements || []).map(e => ({ ...e, source: slideId }))] : []
  const chosen = selection.length === 1 ? elements.find(e => e.id === selection[0]) : null
  useEffect(() => { setText(chosen?.text || ''); setName(chosen?.name || ''); setFontSize(String(chosen?.style?.font_size || '')) }, [chosen?.id, chosen?.text, chosen?.name, chosen?.style?.font_size])
  useEffect(() => { setNotesText(slide?.notes || '') }, [slide?.id, slide?.notes])
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
      chosen.kind === 'chart' && h('div', { className: 'ppt-form-row' },
        h('label', { className: 'ppt-field-label' }, '图表类型'),
        h('select', {
          className: 'ppt-input ppt-cupertino-input',
          'aria-label': '切换图表类型',
          value: chosen.chart_type || 'column',
          disabled: !!busy,
          onChange: e => c.edit([{ action: 'update_element', target: chosen.id, changes: { chart_type: e.target.value } }], '切换图表类型')
        },
          h('option', { value: 'column' }, '📊 垂直柱状图 (Column)'),
          h('option', { value: 'bar' }, '📶 水平条形图 (Bar)'),
          h('option', { value: 'line' }, '📈 折线趋势图 (Line)'),
          h('option', { value: 'area' }, '📉 面积趋势图 (Area)'),
          h('option', { value: 'pie' }, '🥧 饼图分布 (Pie)'),
          h('option', { value: 'donut' }, '🍩 环形图占比 (Donut)'),
          h('option', { value: 'radar' }, '🕸️ 综合雷达图 (Radar)')
        )
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
    slide && h('div', { className: 'ppt-fields ppt-inspector-card ppt-notes-card' },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 } },
        h('strong', null, '🎙️ 本页演讲备忘 (Speaker Notes)'),
        button('✨ AI 生成讲稿', () => void c.generateNotes(slide.id), !!busy, { className: 'ppt-btn-primary' })
      ),
      h(Textarea, {
        value: notesText,
        placeholder: '记录本页核心提词、演讲逻辑或点击上方【✨ AI 生成讲稿】…',
        rows: 4,
        onChange: e => setNotesText(e.target.value),
        onBlur: () => {
          if (notesText !== (slide.notes || '')) {
            void c.updateNotes(slide.id, notesText)
          }
        }
      }),
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 } },
        h('small', { className: 'ppt-muted' }, '放映模式按 N 可随时调出本讲稿备忘'),
        notesText !== (slide.notes || '') && button('保存备注', () => void c.updateNotes(slide.id, notesText), !!busy)
      )
    ),
  )
}

function Conversation({ c, expanded = false }) {
  const doc = useValue(c.$doc), draft = useValue(c.$draft), messages = useValue(c.$messages), busy = useValue(c.$busy), error = useValue(c.$error), selection = useValue(c.$selection)
  const attachments = useValue(c.$attachments) || []
  const fileInputRef = useRef(null)
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
        h('p', { className: 'ppt-muted', style: { margin: '4px 0 0' } }, '支持自然语言指令与参考文件补充：\n• 添加参考文件（Word/PPT/Markdown等）补充或扩充PPT\n• 选中任意元素直接点击【根据选定元素生图】\n• 自然语言修改标题、正文、版式与全篇风格')
      ),
      ...messages.map((m, i) => h('div', { key: i, className: `ppt-msg-bubble ${m.role === 'user' ? 'ppt-user-message ppt-msg-user' : 'ppt-msg-assistant'}` },
        h('strong', null, m.role === 'user' ? '你：' : 'PPT：'),
        h('div', { className: 'ppt-msg-text' }, m.text),
        m.attachments?.length > 0 && h('div', { className: 'ppt-msg-attachments' },
          m.attachments.map((name, idx) => h('span', { key: idx, className: 'ppt-msg-att-badge' }, `📎 ${name}`))
        )
      )),
      busy && h('div', { role: 'status', className: 'ppt-msg-bubble ppt-msg-assistant', style: flex },
        h(GlyphSpinner),
        h('span', null, busy.label)
      ),
      error && h('p', { role: 'alert', className: 'ppt-error' }, error)
    ),
    selection.length > 0 && h('div', { className: 'ppt-selection-bar ppt-cupertino-card' },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
        h('span', { className: 'ppt-selection-dot' }),
        h('span', { className: 'ppt-selection-label' }, `已选定元素：${selection.join('、')}`)
      ),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 } },
        h('button', {
          type: 'button',
          className: 'ppt-apple-btn-secondary ppt-btn-sm',
          disabled: !!busy,
          onClick: () => {
            c.$imageModalTargetElement.set(selection[0])
            c.$imageModalOpen.set(true)
          }
        }, '🎨 根据选定元素生图'),
        h('button', {
          type: 'button',
          className: 'ppt-apple-btn-secondary ppt-btn-sm',
          onClick: () => c.$selection.set([])
        }, '取消')
      )
    ),
    h('p', { className: 'ppt-muted', style: { margin: '2px 0 0' } }, selection.length ? `当前将优先针对选中元素操作；也可在输入框直接输入要求。` : doc ? '未选择对象；可按页码、名称描述目标，或添加参考文件补充内容。' : '描述主题、受众与总页数后生成初稿，或添加参考文件。'),
    h('div', { className: 'ppt-chat-input-box' },
      attachments.length > 0 && h('div', { className: 'ppt-attached-files-list' },
        attachments.map(att => h('div', { key: att.id, className: 'ppt-file-pill' },
          h('span', { className: 'ppt-file-pill-icon' }, '📄'),
          h('span', { className: 'ppt-file-pill-name', title: att.name }, att.name),
          h('span', { className: 'ppt-file-pill-size' }, `${(att.size / 1024).toFixed(1)} KB`),
          h('button', {
            type: 'button',
            className: 'ppt-file-remove-btn',
            'aria-label': `移除附件 ${att.name}`,
            disabled: !!busy,
            onClick: () => c.removeAttachment(att.id)
          }, '✕')
        ))
      ),
      h(Textarea, { value: draft, rows: 3, disabled: !!busy, placeholder: doc ? (attachments.length ? '已附带文件，在此输入具体补充或修改要求…' : '描述本次修改，或添加参考文件补充内容…') : (attachments.length ? '已附带文件，在此输入主题与要求…' : '生成一份……或添加文件补充内容'), 'aria-label': 'PPT 对话指令',
        onChange: event => c.$draft.set(event.target.value), onKeyDown: event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void c.send() } } }),
      h('div', { className: 'ppt-input-footer' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('input', {
            type: 'file',
            multiple: true,
            hidden: true,
            ref: fileInputRef,
            accept: '.docx,.pptx,.txt,.md,.markdown,.csv,.json,.pdf,.forxppt',
            onChange: async event => {
              const files = Array.from(event.target.files || [])
              event.target.value = ''
              for (const file of files) {
                await c.addAttachment(file)
              }
            }
          }),
          h('button', {
            type: 'button',
            className: 'ppt-attach-btn ppt-apple-btn-secondary ppt-btn-sm',
            disabled: !!busy,
            onClick: () => fileInputRef.current?.click()
          }, '📎 添加参考文件'),
          h('small', { className: 'ppt-muted' }, 'Ctrl+Enter 发送')
        ),
        h('div', { style: flex },
          busy?.requestId && button('取消本次指令', c.cancel),
          button(doc ? '发送修改' : '生成初稿', c.send, !!busy || (!draft.trim() && attachments.length === 0), { className: 'ppt-btn-primary' })
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

/* Modals & Cupertino Sheets */
.ppt-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,0.4);backdrop-filter:blur(16px) saturate(180%);-webkit-backdrop-filter:blur(16px) saturate(180%);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;animation:ppt-fade-in 0.2s ease-out}
@keyframes ppt-fade-in{from{opacity:0}to{opacity:1}}

.ppt-modal{background:rgba(255,255,255,0.95);color:#1d1d1f;border:1px solid rgba(255,255,255,0.8);border-radius:20px;box-shadow:0 30px 70px rgba(0,0,0,0.22),0 0 0 1px rgba(0,0,0,0.06),inset 0 1px 0 rgba(255,255,255,0.9);display:flex;flex-direction:column;overflow:hidden;animation:ppt-sheet-up 0.25s cubic-bezier(0.16,1,0.3,1);max-height:90vh;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","PingFang SC","Helvetica Neue",sans-serif}
@keyframes ppt-sheet-up{from{opacity:0;transform:scale(0.96) translateY(12px)}to{opacity:1;transform:scale(1) translateY(0)}}

/* Cupertino Dark Mode Adaptation */
:is(.dark,[data-hermes-mode="dark"],[data-color-mode="dark"]) .ppt-modal{background:rgba(32,32,36,0.95);color:#f5f5f7;border:1px solid rgba(255,255,255,0.12);box-shadow:0 30px 80px rgba(0,0,0,0.65),0 0 0 1px rgba(255,255,255,0.06),inset 0 1px 0 rgba(255,255,255,0.14)}

.ppt-cupertino-sheet-header{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid rgba(120,120,128,0.15);background:transparent}
.ppt-modal-title{font-size:16px;font-weight:600;color:inherit;margin:0;letter-spacing:-0.2px}
.ppt-apple-badge{display:inline-block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#0071e3;background:rgba(0,113,227,0.12);padding:2px 8px;border-radius:980px}
:is(.dark,[data-hermes-mode="dark"],[data-color-mode="dark"]) .ppt-apple-badge{background:rgba(10,132,255,0.2);color:#2997ff}

.ppt-cupertino-close-btn{width:28px;height:28px;border-radius:50%;border:none;background:rgba(120,120,128,0.14);color:inherit;opacity:0.75;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:12px;line-height:1;transition:all 0.15s ease}
.ppt-cupertino-close-btn:hover:not(:disabled){opacity:1;background:rgba(120,120,128,0.25);transform:scale(1.06)}
.ppt-cupertino-close-btn:active:not(:disabled){transform:scale(0.92)}
.ppt-cupertino-close-btn:disabled{opacity:0.3;cursor:not-allowed}

.ppt-cupertino-sheet-body{padding:20px 22px;display:flex;flex-direction:column;gap:14px;overflow-y:auto}
.ppt-cupertino-sheet-footer{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:14px 22px;border-top:1px solid rgba(120,120,128,0.15);background:transparent}

/* Layout Picker Modal */
.ppt-layout-modal{width:880px;max-width:96vw}
.ppt-cupertino-layout-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;padding:18px 22px;overflow-y:auto;max-height:62vh}
.ppt-cupertino-card{background:rgba(120,120,128,0.06);border:1px solid rgba(120,120,128,0.15);border-radius:14px;padding:10px;cursor:pointer;display:flex;flex-direction:column;gap:8px;transition:all 0.2s cubic-bezier(0.16,1,0.3,1);box-shadow:0 1px 3px rgba(0,0,0,0.03)}
.ppt-cupertino-card:hover{border-color:#0071e3;background:rgba(0,113,227,0.04);transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,113,227,0.16)}
:is(.dark,[data-hermes-mode="dark"],[data-color-mode="dark"]) .ppt-cupertino-card{background:rgba(255,255,255,0.04);border-color:rgba(255,255,255,0.08)}
:is(.dark,[data-hermes-mode="dark"],[data-color-mode="dark"]) .ppt-cupertino-card:hover{border-color:#2997ff;background:rgba(10,132,255,0.08);box-shadow:0 8px 24px rgba(10,132,255,0.25)}

.ppt-wireframe-wrap{width:100%;border-radius:8px;overflow:hidden;background:rgba(0,0,0,0.02)}
.ppt-layout-card-content{display:flex;flex-direction:column;gap:4px;padding:2px 4px}
.ppt-layout-card-header{display:flex;align-items:center;gap:8px}
.ppt-layout-card-icon{font-size:18px;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:7px;background:rgba(0,113,227,0.1)}
.ppt-layout-card-meta{display:flex;flex-direction:column}
.ppt-layout-card-id{font-size:10px;font-weight:700;color:#0071e3}
:is(.dark,[data-hermes-mode="dark"],[data-color-mode="dark"]) .ppt-layout-card-id{color:#2997ff}
.ppt-layout-card-name{font-size:12.5px;color:inherit;font-weight:600}
.ppt-layout-card-desc{font-size:11px;color:rgba(120,120,128,0.9);margin:0;line-height:1.4}
.ppt-layout-card-bullets{margin:2px 0 0;padding-left:16px;font-size:10.5px;color:rgba(120,120,128,0.8);line-height:1.4}

/* Doc to Deck Modal */
.ppt-doc-modal{width:720px;max-width:94vw}
.ppt-presets-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:2px}
.ppt-presets-label{font-size:11px;font-weight:600;color:rgba(120,120,128,0.9)}
.ppt-preset-chip{border:1px solid rgba(120,120,128,0.2);background:rgba(120,120,128,0.08);color:inherit;border-radius:980px;padding:4px 10px;font-size:11.5px;cursor:pointer;transition:all 0.15s ease;display:inline-flex;align-items:center;gap:4px}
.ppt-preset-chip:hover:not(:disabled){background:rgba(0,113,227,0.12);border-color:rgba(0,113,227,0.35);color:#0071e3;transform:translateY(-1px)}
:is(.dark,[data-hermes-mode="dark"],[data-color-mode="dark"]) .ppt-preset-chip:hover:not(:disabled){color:#2997ff;border-color:rgba(10,132,255,0.4)}
.ppt-upload-chip{border-style:dashed;background:transparent}

.ppt-cupertino-input,.ppt-cupertino-textarea{width:100%;border-radius:10px;border:1px solid rgba(120,120,128,0.22);background:rgba(120,120,128,0.06);color:inherit;font-size:13px;padding:8px 12px;box-sizing:border-box;transition:all 0.15s ease;font-family:inherit}
.ppt-cupertino-input:focus,.ppt-cupertino-textarea:focus{outline:none;border-color:#0071e3;background:rgba(255,255,255,0.98);box-shadow:0 0 0 3px rgba(0,113,227,0.25)}
:is(.dark,[data-hermes-mode="dark"],[data-color-mode="dark"]) .ppt-cupertino-input:focus,
:is(.dark,[data-hermes-mode="dark"],[data-color-mode="dark"]) .ppt-cupertino-textarea:focus{background:rgba(44,44,48,0.98);border-color:#2997ff;box-shadow:0 0 0 3px rgba(10,132,255,0.3)}
.ppt-cupertino-textarea{resize:vertical;line-height:1.55}
.ppt-char-counter{font-size:11px;color:rgba(120,120,128,0.85);font-weight:500}
.ppt-char-counter-valid{color:#34c759;font-weight:600}

/* Segmented Control */
.ppt-cupertino-segmented{background:rgba(120,120,128,0.12);border-radius:9px;padding:2px;display:flex;gap:2px;user-select:none;border:1px solid rgba(120,120,128,0.08)}
.ppt-cupertino-segment{flex:1;padding:5px 8px;border-radius:7px;font-size:11.5px;font-weight:500;text-align:center;cursor:pointer;border:none;background:transparent;color:inherit;opacity:0.75;transition:all 0.18s cubic-bezier(0.16,1,0.3,1);white-space:nowrap}
.ppt-cupertino-segment:hover:not(:disabled){opacity:1}
.ppt-cupertino-segment-active{background:#ffffff!important;color:#1d1d1f!important;opacity:1!important;box-shadow:0 2px 6px rgba(0,0,0,0.1),0 0.5px 1px rgba(0,0,0,0.08)!important;font-weight:600!important}
:is(.dark,[data-hermes-mode="dark"],[data-color-mode="dark"]) .ppt-cupertino-segment-active{background:rgba(255,255,255,0.22)!important;color:#ffffff!important;box-shadow:0 2px 6px rgba(0,0,0,0.35)!important}

.ppt-form-grid-2col{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.ppt-form-col{display:flex;flex-direction:column;gap:5px}

/* Apple Buttons */
.ppt-apple-btn-primary{background:linear-gradient(180deg,#0077ED 0%,#0066CC 100%);color:#ffffff;border:none;border-radius:980px;padding:7px 20px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,102,204,0.3);transition:all 0.15s ease;display:inline-flex;align-items:center;justify-content:center;gap:6px}
.ppt-apple-btn-primary:hover:not(:disabled){background:linear-gradient(180deg,#0A84FF 0%,#0071E3 100%);box-shadow:0 4px 14px rgba(0,102,204,0.45);transform:translateY(-0.5px)}
.ppt-apple-btn-primary:active:not(:disabled){transform:scale(0.97)}
.ppt-apple-btn-primary:disabled{opacity:0.38;cursor:not-allowed;box-shadow:none}

.ppt-apple-btn-secondary{background:rgba(120,120,128,0.12);color:inherit;border:none;border-radius:980px;padding:7px 18px;font-size:13px;font-weight:500;cursor:pointer;transition:all 0.15s ease}
.ppt-apple-btn-secondary:hover:not(:disabled){background:rgba(120,120,128,0.22)}
.ppt-apple-btn-secondary:active:not(:disabled){transform:scale(0.97)}
.ppt-apple-btn-secondary:disabled{opacity:0.35;cursor:not-allowed}
.ppt-suggestion-primary{border-color:color-mix(in srgb, var(--ui-accent) 40%, transparent)!important;background:color-mix(in srgb, var(--ui-accent) 10%, transparent)!important}

/* Destructive / Delete Styles */
.ppt-btn-danger{color:#ff3b30!important;background:color-mix(in srgb, #ff3b30 8%, transparent)!important;border-color:color-mix(in srgb, #ff3b30 25%, transparent)!important}
.ppt-btn-danger:hover:not(:disabled){background:color-mix(in srgb, #ff3b30 18%, transparent)!important;color:#ff453a!important}
.ppt-pages-header-actions{display:flex;align-items:center;gap:6px}
.ppt-icon-btn-danger{border:none;background:transparent;cursor:pointer;padding:2px 4px;font-size:12px;opacity:0.65;border-radius:4px;transition:all 0.15s ease;line-height:1}
.ppt-icon-btn-danger:hover:not(:disabled){opacity:1;transform:scale(1.1);background:rgba(255,59,48,0.15)}
.ppt-apple-btn-danger{background:linear-gradient(180deg,#FF453A 0%,#FF3B30 100%);color:#ffffff;border:none;border-radius:980px;padding:7px 20px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(255,59,48,0.35);transition:all 0.15s ease;display:inline-flex;align-items:center;justify-content:center;gap:6px}
.ppt-apple-btn-danger:hover:not(:disabled){background:linear-gradient(180deg,#FF5E55 0%,#E02E24 100%);box-shadow:0 4px 14px rgba(255,59,48,0.5);transform:translateY(-0.5px)}
.ppt-apple-btn-danger:active:not(:disabled){transform:scale(0.97)}
.ppt-apple-btn-danger:disabled{opacity:0.38;cursor:not-allowed;box-shadow:none}
.ppt-badge-danger{background:rgba(255,59,48,0.12)!important;color:#ff3b30!important;border:1px solid rgba(255,59,48,0.3)!important}
.ppt-delete-modal{width:460px;max-width:92vw}
.ppt-delete-info-card{background:rgba(120,120,128,0.08);border:1px solid rgba(120,120,128,0.18);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
.ppt-delete-info-row{display:flex;align-items:center;justify-content:space-between;font-size:12.5px}
.ppt-delete-info-title{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ui-text-primary)}
.ppt-delete-warning-box{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:10px;background:rgba(255,59,48,0.08);border:1px solid rgba(255,59,48,0.2);color:var(--ui-text-primary);font-size:12px;line-height:1.5}
.ppt-delete-warning-icon{font-size:16px;flex-shrink:0}
.ppt-delete-warning-text strong{color:#ff3b30}

/* Image Generation Modal Styles */
.ppt-image-modal{width:640px;max-width:92vw}
.ppt-ai-extract-card{background:rgba(120,120,128,0.08);border:1px solid rgba(120,120,128,0.18);border-radius:10px;padding:8px 12px;margin-bottom:6px}
.ppt-ai-extract-header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ppt-auto-prompt-btn{background:rgba(0,113,227,0.12)!important;color:#0071e3!important;border:1px solid rgba(0,113,227,0.3)!important;border-radius:980px!important;padding:4px 10px!important;font-size:11.5px!important;font-weight:600!important;cursor:pointer;transition:all 0.15s ease}
.ppt-auto-prompt-btn:hover:not(:disabled){background:rgba(0,113,227,0.22)!important;transform:translateY(-0.5px)}
:is(.dark,[data-hermes-mode="dark"],[data-color-mode="dark"]) .ppt-auto-prompt-btn{color:#2997ff!important;border-color:rgba(41,151,255,0.4)!important}

/* Selection Quick Action Bar */
.ppt-selection-bar{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:rgba(0,113,227,0.08);border:1px solid rgba(0,113,227,0.22);border-radius:10px;font-size:12px;margin:6px 0 2px;gap:8px}
.ppt-selection-dot{width:7px;height:7px;border-radius:50%;background:#0071e3;box-shadow:0 0 6px rgba(0,113,227,0.5);flex-shrink:0}
.ppt-selection-label{font-weight:600;color:var(--ui-text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ppt-btn-sm{padding:3px 10px!important;font-size:11.5px!important;height:24px!important;border-radius:980px!important}
.ppt-target-element-card{border-color:rgba(0,113,227,0.35)!important;background:rgba(0,113,227,0.06)!important}

/* File Attachments Pills */
.ppt-attached-files-list{display:flex;flex-wrap:wrap;gap:6px;padding:6px 8px;border-bottom:1px solid var(--ui-stroke-secondary);background:color-mix(in srgb, var(--ui-bg-elevated) 60%, transparent);border-radius:8px 8px 0 0}
.ppt-file-pill{display:inline-flex;align-items:center;gap:5px;padding:2px 8px 2px 9px;border-radius:980px;background:rgba(0,113,227,0.09);border:1px solid rgba(0,113,227,0.25);font-size:11.5px;color:var(--ui-text-primary);max-width:100%;transition:all 0.15s ease}
.ppt-file-pill-icon{font-size:12px;flex-shrink:0}
.ppt-file-pill-name{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.ppt-file-pill-size{font-size:10px;color:var(--ui-text-secondary);opacity:0.8;flex-shrink:0}
.ppt-file-remove-btn{border:none;background:rgba(120,120,128,0.18);color:var(--ui-text-secondary);cursor:pointer;border-radius:50%;width:15px;height:15px;font-size:9px;line-height:1;display:flex;align-items:center;justify-content:center;padding:0;transition:all 0.15s ease}
.ppt-file-remove-btn:hover:not(:disabled){background:#ff3b30;color:#ffffff}
.ppt-attach-btn{display:inline-flex;align-items:center;gap:4px}
.ppt-msg-attachments{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.ppt-msg-att-badge{display:inline-flex;align-items:center;padding:2px 7px;border-radius:6px;background:rgba(120,120,128,0.12);border:1px solid var(--ui-stroke-secondary);font-size:10.5px;color:var(--ui-text-secondary)}

/* Re-Layout and Direct Manipulation Styles */
.ppt-relayout-btn{background:rgba(0,113,227,0.12)!important;color:#0071e3!important;border:1px solid rgba(0,113,227,0.25)!important;border-radius:980px!important;padding:3px 10px!important;font-size:11.5px!important;font-weight:600!important;cursor:pointer;transition:all 0.15s ease}
.ppt-relayout-btn:hover:not(:disabled){background:rgba(0,113,227,0.22)!important;transform:translateY(-0.5px)}
:is(.dark,[data-hermes-mode="dark"],[data-color-mode="dark"]) .ppt-relayout-btn{color:#2997ff!important;border-color:rgba(41,151,255,0.4)!important}

.ppt-layout-card-current{border-color:#0071e3!important;box-shadow:0 0 0 2px rgba(0,113,227,0.3)!important;background:color-mix(in srgb, var(--ui-bg-elevated) 90%, #0071e3)!important}
.ppt-current-badge{margin-left:auto;font-size:10px;font-weight:700;color:#0071e3;background:rgba(0,113,227,0.12);padding:2px 6px;border-radius:4px}
:is(.dark,[data-hermes-mode="dark"],[data-color-mode="dark"]) .ppt-current-badge{color:#2997ff}

/* Inline Text Editing Overlay */
.ppt-inline-edit-overlay{box-sizing:border-box;box-shadow:0 8px 24px rgba(0,0,0,0.25),0 0 0 2px #0071e3;border-radius:6px;overflow:hidden;background:rgba(255,255,255,0.96);backdrop-filter:blur(10px)}
:is(.dark,[data-hermes-mode="dark"],[data-color-mode="dark"]) .ppt-inline-edit-overlay{background:rgba(30,30,32,0.96)}
.ppt-inline-textarea{width:100%;height:100%;box-sizing:border-box;border:none;outline:none;background:transparent;padding:6px 8px;font-family:inherit;font-size:13px;line-height:1.45;color:inherit;resize:none}

.ppt-drag-dimension-badge{pointer-events:none;user-select:none}

/* Presentation Mode (Cupertino Glassmorphism) */
.ppt-presentation-overlay{position:fixed;inset:0;z-index:9999;background:#000000;display:flex;align-items:center;justify-content:center;overflow:hidden;user-select:none}
.ppt-laser-cursor{cursor:none!important}
.ppt-presentation-stage{width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:20px}
.ppt-presentation-svg-wrapper{width:100%;height:100%;display:flex;align-items:center;justify-content:center}
.ppt-presentation-svg-wrapper svg{max-width:96vw;max-height:92vh;width:auto;height:auto;aspect-ratio:16/9;filter:drop-shadow(0 12px 48px rgba(0,0,0,0.8));border-radius:4px}
.ppt-presentation-loading{display:flex;flex-direction:column;align-items:center;gap:12px;color:rgba(255,255,255,0.7);font-size:14px}
.ppt-presentation-blackout{position:fixed;inset:0;background:#000000;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:10001}
.ppt-blackout-hint{color:rgba(255,255,255,0.4);font-size:14px;letter-spacing:1px}

/* Laser Pointer */
.ppt-laser-pointer-dot{position:fixed;width:12px;height:12px;border-radius:50%;background:#ff3b30;box-shadow:0 0 10px #ff3b30, 0 0 20px #ff3b30, 0 0 3px #ffffff;pointer-events:none;transform:translate(-50%, -50%);z-index:10002;transition:transform 0.04s ease}

/* Presentation Floating HUD */
.ppt-presentation-hud{position:fixed;bottom:28px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:8px;padding:6px 14px;background:rgba(30,30,32,0.82);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border:1px solid rgba(255,255,255,0.15);border-radius:980px;box-shadow:0 12px 36px rgba(0,0,0,0.5);z-index:10000;transition:opacity 0.25s ease, transform 0.25s ease}
.ppt-hud-visible{opacity:1;pointer-events:all}
.ppt-hud-hidden{opacity:0;pointer-events:none;transform:translateX(-50%) translateY(12px)}
.ppt-hud-btn{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);color:#ffffff;border-radius:980px;padding:6px 12px;font-size:12px;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;gap:5px;transition:all 0.15s ease}
.ppt-hud-btn:hover:not(:disabled){background:rgba(255,255,255,0.18);transform:translateY(-1px)}
.ppt-hud-btn:disabled{opacity:0.3;cursor:not-allowed}
.ppt-hud-active{background:#0071e3!important;border-color:#0071e3!important;box-shadow:0 0 12px rgba(0,113,227,0.5)}
.ppt-hud-exit{background:rgba(255,59,48,0.15)!important;border-color:rgba(255,59,48,0.3)!important;color:#ff453a!important}
.ppt-hud-exit:hover{background:rgba(255,59,48,0.3)!important}
.ppt-hud-counter{display:flex;align-items:center;font-size:12px;padding:0 6px;color:#ffffff;font-variant-numeric:tabular-nums}
.ppt-hud-index{font-weight:600}
.ppt-hud-total{color:rgba(255,255,255,0.5)}
.ppt-hud-divider{width:1px;height:16px;background:rgba(255,255,255,0.15);margin:0 2px}

/* Presentation Notes HUD */
.ppt-presentation-notes-hud{position:fixed;bottom:90px;right:32px;width:340px;max-height:280px;background:rgba(24,24,26,0.88);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border:1px solid rgba(255,255,255,0.16);border-radius:14px;box-shadow:0 16px 40px rgba(0,0,0,0.6);z-index:10000;display:flex;flex-direction:column;overflow:hidden;animation:pptFadeUp 0.2s ease}
.ppt-notes-hud-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(255,255,255,0.05);border-bottom:1px solid rgba(255,255,255,0.1)}
.ppt-notes-hud-title{font-size:12px;font-weight:600;color:#ffffff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ppt-notes-hud-close{background:none;border:none;color:rgba(255,255,255,0.6);cursor:pointer;font-size:13px;padding:2px 6px;border-radius:4px}
.ppt-notes-hud-close:hover{color:#ffffff;background:rgba(255,255,255,0.1)}
.ppt-notes-hud-body{padding:12px 14px;overflow-y:auto;font-size:13px;line-height:1.6;color:rgba(255,255,255,0.92)}
.ppt-notes-empty{color:rgba(255,255,255,0.4);font-style:italic;margin:0}

/* Notes Card in Properties Panel */
.ppt-notes-card{background:color-mix(in srgb, var(--ui-bg-elevated) 90%, var(--ui-accent))!important;border:1px solid color-mix(in srgb, var(--ui-stroke-secondary) 70%, var(--ui-accent))!important}
.ppt-btn-present{background:linear-gradient(135deg, #0071e3, #47a3ff)!important;color:#ffffff!important;font-weight:600!important}

/* Export Modal Sheet */
.ppt-export-modal-sheet{max-width:680px!important;padding:24px 28px!important}
.ppt-export-grid{display:flex;flex-direction:column;gap:10px;margin-top:14px}
.ppt-export-card{display:flex;align-items:center;gap:14px;padding:12px 16px;border-radius:12px;background:var(--ui-bg-elevated);border:1px solid var(--ui-stroke-secondary);cursor:pointer;transition:all 0.16s ease}
.ppt-export-card:hover{border-color:var(--ui-accent);background:color-mix(in srgb, var(--ui-accent) 6%, var(--ui-bg-elevated));transform:translateY(-1px);box-shadow:0 4px 16px rgba(0,0,0,0.06)}
.ppt-export-card-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.ppt-export-card-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.ppt-export-card-title{font-size:13.5px;font-weight:600;color:var(--ui-text-primary)}
.ppt-export-card-desc{font-size:11.5px;color:var(--ui-text-secondary);margin:0;line-height:1.45}
.ppt-export-badge{align-self:flex-start;font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;background:rgba(0,113,227,0.1);color:#0071e3;margin-top:3px}

/* Brand Kit Modal */
.ppt-brandkit-modal{max-width:680px!important;padding:24px 28px!important}
.ppt-brandkit-section{margin-bottom:20px}
.ppt-section-title{font-size:13px;font-weight:700;color:var(--ui-text-primary);margin:0 0 10px 0}
.ppt-preset-themes-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}
.ppt-theme-card{display:flex;flex-direction:column;padding:10px 12px;border-radius:12px;background:var(--ui-bg-elevated);border:1px solid var(--ui-stroke-secondary);cursor:pointer;position:relative;transition:all 0.16s ease}
.ppt-theme-card:hover{border-color:var(--ui-accent);transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,0.06)}
.ppt-theme-card-active{border-color:#0071e3!important;box-shadow:0 0 0 2px rgba(0,113,227,0.3)!important;background:color-mix(in srgb, var(--ui-bg-elevated) 92%, #0071e3)!important}
.ppt-theme-palette-bar{display:flex;height:8px;border-radius:4px;overflow:hidden;gap:2px;margin-bottom:8px}
.ppt-theme-palette-bar span{flex:1}
.ppt-theme-name{font-size:12.5px;color:var(--ui-text-primary);display:block}
.ppt-theme-desc{font-size:11px;color:var(--ui-text-secondary);margin:2px 0 0 0}
.ppt-theme-current-badge{position:absolute;top:8px;right:8px;font-size:10px;font-weight:700;color:#0071e3;background:rgba(0,113,227,0.12);padding:1px 5px;border-radius:4px}
:is(.dark,[data-hermes-mode="dark"],[data-color-mode="dark"]) .ppt-theme-current-badge{color:#2997ff}

.ppt-custom-colors-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.ppt-color-picker-item{display:flex;flex-direction:column;gap:5px}
.ppt-color-label{font-size:11.5px;color:var(--ui-text-secondary);font-weight:500}
.ppt-color-input-wrapper{display:flex;align-items:center;gap:6px}
.ppt-color-input-wrapper input[type="color"]{width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;padding:0;background:transparent}
.ppt-hex-input{width:76px;font-family:monospace;font-size:12px;padding:4px 6px;border-radius:6px;border:1px solid var(--ui-stroke-secondary);background:var(--ui-bg-input);color:var(--ui-text-primary)}

.ppt-logo-asset-card{padding:14px;border-radius:12px;background:var(--ui-bg-elevated);border:1px solid var(--ui-stroke-secondary);display:flex;flex-direction:column;gap:12px}
.ppt-logo-preview-box{min-height:36px;display:flex;align-items:center;padding:8px 12px;border-radius:8px;background:rgba(120,120,128,0.06);font-size:12.5px}
.ppt-logo-active-text{color:#0071e3;font-weight:600}
:is(.dark,[data-hermes-mode="dark"],[data-color-mode="dark"]) .ppt-logo-active-text{color:#2997ff}
.ppt-logo-controls{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}

/* Outline Editor in Doc-to-Deck */
.ppt-outline-modal-sheet{max-width:760px!important;padding:24px 28px!important}
.ppt-outline-cards-list{display:flex;flex-direction:column;gap:12px;max-height:48vh;overflow-y:auto;padding-right:4px;margin:12px 0}
.ppt-outline-card{padding:12px 14px;border-radius:12px;background:var(--ui-bg-elevated);border:1px solid var(--ui-stroke-secondary);display:flex;flex-direction:column;gap:8px}
.ppt-outline-slide-header{display:flex;align-items:center;gap:10px}
.ppt-outline-index-badge{font-size:11.5px;font-weight:700;color:var(--ui-accent);padding:2px 8px;border-radius:980px;background:rgba(0,113,227,0.1);flex-shrink:0}
.ppt-outline-layout-select{max-width:180px;padding:3px 8px!important;font-size:12px!important;height:28px!important}
.ppt-outline-actions{display:flex;align-items:center;gap:4px;margin-left:auto}
.ppt-outline-actions button{background:rgba(120,120,128,0.1);border:1px solid var(--ui-stroke-secondary);border-radius:6px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--ui-text-primary);font-size:11px;transition:all 0.15s ease}
.ppt-outline-actions button:hover:not(:disabled){background:rgba(120,120,128,0.2)}
.ppt-outline-actions button:disabled{opacity:0.3;cursor:not-allowed}
.ppt-outline-delete-btn:hover:not(:disabled){background:rgba(255,59,48,0.15)!important;color:#ff3b30!important;border-color:rgba(255,59,48,0.3)!important}
.ppt-outline-title-input{font-weight:600;font-size:13px!important;padding:5px 10px!important}
.ppt-outline-bullets-input{font-size:12px!important;line-height:1.5!important;padding:6px 10px!important;resize:vertical}
.ppt-add-outline-btn{width:100%;margin-top:6px;padding:8px!important;font-size:12.5px!important;border-style:dashed!important}

/* Print Styles for Vector PDF */
@media print{
  body{background:#ffffff!important;color:#000000!important;margin:0!important;padding:0!important}
  .ppt-toolbar,.ppt-pages,.ppt-side,.ppt-stage-header,.ppt-canvas-footer,.ppt-modal-backdrop,.ppt-selection,.ppt-inline-edit-overlay,.ppt-presentation-overlay{display:none!important}
  .forx-ppt,.ppt-layout,.ppt-canvas-area,.ppt-canvas-viewport{display:block!important;margin:0!important;padding:0!important;width:100%!important;height:auto!important}
  .ppt-canvas-wrapper{box-shadow:none!important;border:none!important;width:100vw!important;height:100vh!important;page-break-after:always!important;page-break-inside:avoid!important;display:flex!important;align-items:center!important;justify-content:center!important;margin:0!important}
  .ppt-svg{position:relative!important;width:100%!important;height:100%!important}
  @page{size:landscape;margin:0}
}

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
  useEffect(() => {
    const handleGlobalKey = e => {
      if (e.key === 'F5') {
        e.preventDefault()
        if (c.$doc.get()) c.$presenting.set(!c.$presenting.get())
      }
    }
    window.addEventListener('keydown', handleGlobalKey)
    return () => window.removeEventListener('keydown', handleGlobalKey)
  }, [c])
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
    h(DocToDeckModal, { c }),
    h(BrandKitModal, { c }),
    h(DeleteProjectModal, { c }),
    h(ImageGenModal, { c }),
    h(SlideReLayoutModal, { c }),
    h(ExportModal, { c }),
    h(PresentationView, { c })
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

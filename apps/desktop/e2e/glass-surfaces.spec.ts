import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { desktopColorSeeds, THEME_PRESET_PALETTES } from '@hermes/shared/theme-presets'
import { expect, type Page, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

const desktop = path.resolve(import.meta.dirname, '..')
let server: ViteDevServer
let scratch: string
let url: string

test.beforeAll(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-glass-'))
  // Match the existing component-browser fixtures without sharing Vite's cache.
  Object.assign(globalThis, { __dirname: desktop })
  server = await createServer({
    root: desktop,
    configFile: path.join(desktop, 'vite.config.ts'),
    configLoader: 'runner',
    cacheDir: path.join(scratch, 'node_modules/.vite'),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    optimizeDeps: { entries: ['scripts/fixtures/glass-surfaces.html'] }
  })
  await server.listen()
  url = `${server.resolvedUrls!.local[0]}scripts/fixtures/glass-surfaces.html`
})

test.afterAll(async () => {
  await server?.close()

  if (scratch) {
    await fs.rm(scratch, { recursive: true, force: true })
  }
})

async function sampleRow(page: Page, x: number, y: number, width: number): Promise<number[][]> {
  const pixels = await page.screenshot({
    clip: { x, y, width, height: 1 },
    omitBackground: true,
    scale: 'css'
  })

  return page.evaluate(async image => {
    const bitmap = new Image()
    bitmap.src = image
    await bitmap.decode()
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = 1
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const row = context.getImageData(0, 0, bitmap.width, 1).data

    return Array.from({ length: bitmap.width }, (_, i) => Array.from(row.subarray(i * 4, i * 4 + 4)))
  }, `data:image/png;base64,${pixels.toString('base64')}`)
}

test('tool activity stays compact until the reader opens its details', async ({ page }) => {
  for (const appearance of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: appearance })
    await page.goto(`${url}?tools&${appearance}`)
    const content = page.getByTestId('first-transcript').locator('[data-slot="aui_assistant-message-content"]')
    const groups = content.locator(':scope > [data-tool-group]')
    const rows = content.locator('[data-tool-row]')
    await expect(rows).toHaveCount(2)

    // The range reserves room for output. Only the header paints while collapsed.
    await expect(groups.first()).toHaveCSS('box-shadow', 'none')
    await expect(groups.first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(rows.first()).toContainText('查看工具说明')
    const readingWidth = (await content.boundingBox())!.width
    const failed = rows.last()
    const toggle = failed.getByRole('button', { expanded: false })
    await expect(toggle).toContainText('调用工具 · forx_publish_check')
    await expect(failed.getByLabel('错误', { exact: true })).toBeVisible()
    expect((await failed.boundingBox())!.width).toBeLessThan(readingWidth * 0.85)
    await content.screenshot({ path: test.info().outputPath(`tool-activity-${appearance}.png`) })

    await toggle.focus()
    await page.keyboard.press('Enter')
    await expect(failed.getByRole('button', { expanded: true })).toBeVisible()
    await expect(failed.getByText('请提供插件目录。', { exact: true })).toBeVisible()
    expect((await failed.boundingBox())!.width).toBeGreaterThan(readingWidth * 0.9)
    await page.keyboard.press('Enter')
    await expect(toggle).toBeVisible()
  }
})

test('a live command run keeps its script readable on demand in the Chinese transcript', async ({ page }) => {
  for (const appearance of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: appearance })
    await page.goto(`${url}?tools=run&${appearance}`)
    const transcript = page.getByTestId('first-transcript')
    const group = transcript.locator('[data-tool-group]')
    const summary = group.locator('[data-tool-summary] button[aria-expanded]')
    const ticker = group.locator('[data-tool-ticker]')

    await expect(summary).toBeVisible()
    await expect(ticker).toBeVisible()
    await expect(summary).toHaveAccessibleName('正在运行 3 条命令')
    await expect(group).toHaveCSS('box-shadow', 'none')
    const scriptRow = ticker.getByRole('button', { name: /已运行代码/ })
    await expect(scriptRow).toBeVisible()
    await expect(scriptRow).not.toContainText(/publisher\.py|stdout_bytes|commands/)
    expect((await scriptRow.boundingBox())!.width).toBeLessThan((await group.boundingBox())!.width)
    await transcript.locator('[data-slot="aui_assistant-message-content"]').screenshot({
      path: test.info().outputPath(`thinking-command-run-${appearance}.png`)
    })

    await summary.focus()
    await page.keyboard.press('Tab')
    await expect(scriptRow).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(ticker).toHaveCount(0)
    const details = group.locator('[data-tool-open]')
    await expect(details.getByText('读取成功', { exact: true })).toBeVisible()
    await expect(details.locator('pre').filter({ hasText: 'publisher.py' })).toContainText('print(source.read())')
    await summary.click()
    await expect(scriptRow).toHaveAttribute('aria-expanded', 'false')
    await transcript.locator('..').getByRole('button', { name: 'Finish run' }).click()
    await expect(summary).toHaveAccessibleName('已运行 3 条命令')
    await expect(ticker).toHaveCount(0)
  }
})

test('shell and page navigation keep the same label and icon sizes', async ({ page }) => {
  await page.goto(`${url}?controls`)
  const shellTabs = page.getByTestId('shell-tabs')
  const labelSize = await shellTabs.getByText('Sessions', { exact: true }).evaluate(el => getComputedStyle(el).fontSize)
  const nav = page.getByRole('button', { name: 'New session', exact: true })
  const messaging = page.getByRole('button', { name: 'Messaging', exact: true })
  const settings = page.getByRole('button', { name: 'Settings', exact: true })
  const iconSize = await page.locator('html').evaluate(el => getComputedStyle(el).fontSize)
  const gateway = page.getByRole('button', { name: 'Gateway Ready', exact: true })
  const approval = page.getByRole('button', { name: 'Off', exact: true })
  const rail = page.locator('[data-slot="profile-rail"]')
  const pageNav = page.getByTestId('page-nav')
  const pluginsTab = pageNav.getByRole('button', { name: 'Plugins', exact: true })
  const appearance = page.getByTestId('overlay-nav').getByRole('button', { name: 'Appearance', exact: true })
  const contextUsage = page.getByText('0.6%', { exact: true })
  const version = page.getByText('v1.2.3', { exact: true })

  await expect(shellTabs.getByText('Bots', { exact: true })).toHaveCSS('font-size', labelSize)
  await expect(nav).toHaveCSS('font-size', labelSize)
  await expect(messaging).toHaveCSS('font-size', labelSize)
  await expect(settings.locator('.codicon')).toHaveCSS('font-size', iconSize)
  await expect(nav.locator('.codicon')).toHaveCSS('font-size', iconSize)
  await expect(messaging.locator('svg')).toHaveCSS('width', iconSize)
  await expect(pluginsTab).toHaveCSS('font-size', labelSize)
  await expect(appearance).toHaveCSS('font-size', labelSize)
  await expect(appearance.locator('.codicon-account')).toHaveCSS('font-size', iconSize)
  for (const label of ['Pinned', 'Recent sessions', 'This month', 'October']) {
    await expect(page.getByText(label, { exact: true })).toHaveCSS('font-size', labelSize)
  }
  for (const glyph of ['home', 'add', 'cloud-download', 'ellipsis', 'plug']) {
    await expect(rail.locator(`.codicon-${glyph}`)).toHaveCSS('font-size', iconSize)
  }
  await expect(gateway).toHaveCSS('font-size', labelSize)
  await expect(approval).toHaveCSS('font-size', labelSize)
  await expect(contextUsage).toHaveCSS('font-size', labelSize)
  await expect(page.getByText('⚡', { exact: true })).toHaveCSS('font-size', iconSize)
  await expect(version).toHaveCSS('font-size', labelSize)
  await expect(gateway.locator('svg')).toHaveCSS('width', iconSize)
  await expect(approval.locator('svg')).toHaveCSS('width', iconSize)
  expect((await settings.boundingBox())!.height).toBeGreaterThan(parseFloat(iconSize))

  await page.setViewportSize({ height: 720, width: 400 })
  const statusbar = page.locator('[data-slot="statusbar"]')
  for (const text of ['Gateway', 'Ready', 'zxt', '0.6%', 'Off', 'v1.2.3']) {
    const label = statusbar.getByText(text, { exact: true })
    await expect(label).toBeInViewport({ ratio: 1 })
    expect(await label.evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(await label.evaluate(el => el.clientWidth))
  }

  await expect(pluginsTab).toHaveCSS('font-size', labelSize)
  await expect(pluginsTab.locator('.codicon-chevron-down')).toHaveCSS('font-size', iconSize)
  await expect(appearance).toHaveCSS('font-size', labelSize)
  await expect(appearance.locator('.codicon-account')).toHaveCSS('font-size', iconSize)
  await pluginsTab.click()
  const skillsOption = page.getByRole('menuitem', { name: 'Skills', exact: true })
  await expect(skillsOption).toHaveCSS('font-size', labelSize)
  await skillsOption.click()
  await expect(pageNav.getByRole('button', { name: 'Skills', exact: true })).toBeVisible()
})

test('the docked sidebar divider is visible at rest on window glass', async ({ page }) => {
  await page.goto(`${url}?sidebar&light`)
  const divider = page.getByRole('separator')
  await expect(divider).toBeVisible()
  const bounds = (await divider.boundingBox())!

  // Sample the titlebar and pane body against the glass on both sides.
  for (const dy of [6, bounds.height / 2]) {
    const row = await sampleRow(page, Math.floor(bounds.x) - 3, Math.floor(bounds.y + dy), 8)
    const alpha = row.map(pixel => pixel[3])

    expect(Math.max(...alpha) - Math.max(alpha[0], alpha.at(-1)!)).toBeGreaterThan(12)
  }
})

test('dark sidebar glass stays close to the chat canvas over a neutral backdrop', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(`${url}?sidebar`)
  const bounds = (await page.locator('[data-tree-group]').first().boundingBox())!
  const edge = Math.round(bounds.x + bounds.width)
  const y = Math.floor(bounds.y + bounds.height / 2)
  const seeds = desktopColorSeeds(THEME_PRESET_PALETTES.cupertino.darkColors)

  await page.evaluate(({ edge, seeds }) => {
    const root = document.documentElement
    for (const [name, value] of Object.entries(seeds)) {
      root.style.setProperty(name, value)
    }

    // The browser fixture supplies the neutral material normally painted by the OS.
    root.style.setProperty('background-color', '#939393', 'important')
    root.style.setProperty('--glass-rail-edge', `${edge}px`)
    root.style.setProperty('--translucency-glass-keep', '71%')
  }, { edge, seeds })

  const halfWidth = 24
  const sample = () => sampleRow(page, edge - halfWidth, y, halfWidth * 2)
  const [windowGlass] = await sample()
  await page.locator('html').evaluate(root => root.setAttribute('data-hermes-glass-scope', 'sidebar'))
  const row = await sample()
  const chat = row.at(-1)!
  const channelGap = (a: number[], b: number[]) => Math.max(...a.map((channel, i) => Math.abs(channel - b[i])))

  expect(channelGap(row[0], chat)).toBeGreaterThan(1)
  expect(channelGap(row[0], chat)).toBeLessThan(channelGap(windowGlass, chat) * 0.75)
  // A few pixels inside the rail, the field has already begun to meet the opaque canvas.
  const nearSeam = channelGap(row[halfWidth - 3], chat)
  expect(nearSeam).toBeGreaterThan(1)
  expect(nearSeam).toBeLessThan(channelGap(row[0], chat) * 0.75)

  const viewportWidth = await page.locator('html').evaluate(root => {
    root.setAttribute('dir', 'rtl')
    return root.clientWidth
  })
  const mirrored = await sampleRow(page, viewportWidth - edge - halfWidth, y, halfWidth * 2)
  // Chromium can dither a fractional theme color by one channel step across the gradient.
  expect(channelGap(mirrored[0], chat)).toBeLessThanOrEqual(1)
  expect(channelGap(mirrored.at(-1)!, row[0])).toBeLessThanOrEqual(1)

  await page.locator('html').evaluate(root => {
    root.setAttribute('dir', 'ltr')
    root.style.setProperty('--translucency-glass-keep', '0%')
  })
  const bare = await sample()
  expect(channelGap(bare[0], [147, 147, 147, 255])).toBeLessThanOrEqual(1)
  expect(channelGap(bare.at(-1)!, chat)).toBeLessThanOrEqual(1)
})

test('the first streaming thought stays legible and scrollable', async ({ page }) => {
  await page.goto(`${url}?reasoning&light`)
  const thread = page.getByTestId('first-transcript')
  const preview = thread.locator('[data-slot="aui_thinking-body"]')
  const first = preview.getByText('Reasoning paragraph 1', { exact: true })
  const last = preview.getByText('Reasoning paragraph 16', { exact: true })
  const toggle = thread.getByRole('button', { name: 'Thinking', exact: true })

  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(last).toBeInViewport({ ratio: 1 })
  const overflow = () => preview.evaluate(el => el.scrollHeight - el.clientHeight)
  await expect.poll(overflow).toBeGreaterThan(0)

  const opacity = await last.evaluate(el => {
    let effective = 1

    for (let node: Element | null = el; node; node = node.parentElement) {
      effective *= Number(getComputedStyle(node).opacity)
    }

    return effective
  })

  expect(opacity).toBe(1)
  await expect(preview).not.toHaveCSS('scrollbar-color', 'auto')

  await preview.hover()
  await page.mouse.wheel(0, -1000)
  await expect(first).toBeInViewport({ ratio: 1 })

  await toggle.click()
  await expect(preview).toHaveCount(0)
  await toggle.click()
  await expect.poll(overflow).toBe(0)
})

test('glass tab labels stay clear of the close button without shifting on hover', async ({ page }) => {
  await page.goto(url)
  const tab = page.getByTestId('active-tab')
  const close = tab.getByRole('button', { name: 'Close', exact: true })
  const title = '修复 FORX 桌面端标签栏上文字和关闭按钮重叠的问题'
  const label = tab.getByText(title, { exact: true })
  await expect(label).toBeVisible()

  for (const id of ['active-tab', 'idle-tab', 'fixed-tab']) {
    expect(await page.getByTestId(id).evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
  }

  for (const [id, text] of [
    ['active-tab', title],
    ['idle-tab', 'Another long session title with unsaved changes'],
    ['short-tab', 'X'],
    ['selected-tab', 'Selected']
  ]) {
    const sampleTab = page.getByTestId(id)
    const sampleLabel = sampleTab.getByText(text, { exact: true })
    const sampleClose = sampleTab.getByRole('button', { name: 'Close', exact: true })
    const tabBounds = await sampleTab.boundingBox()
    const labelBounds = (await sampleLabel.boundingBox())!

    await sampleTab.hover()
    await expect(sampleClose).toHaveCSS('pointer-events', 'auto')
    expect(labelBounds.x + labelBounds.width).toBeLessThanOrEqual((await sampleClose.boundingBox())!.x)
    expect(await sampleTab.boundingBox()).toEqual(tabBounds)
    expect(await sampleLabel.boundingBox()).toEqual(labelBounds)
    await expect(sampleClose).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  }

  expect(await label.evaluate(el => el.scrollWidth)).toBeGreaterThan(await label.evaluate(el => el.clientWidth))
  await expect(label).toHaveCSS('text-overflow', 'ellipsis')
  // The active underline remains on the tab itself, without a second stroke
  // on the close button increasing its opacity.
  expect(await tab.evaluate(el => getComputedStyle(el).boxShadow)).toContain('inset')
  await tab.hover()
  await close.click()
  await expect(page.locator('body')).toHaveAttribute('data-closed', 'true')
  await expect(page.locator('body')).not.toHaveAttribute('data-activated', 'true')

  // The tab still honors its surface token in both glass scopes and solid mode.
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-hermes-glass-scope', 'sidebar')
    document.documentElement.style.setProperty('--translucency-glass-keep', '85%')
  })
  expect(await tab.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
  await page.evaluate(() => document.documentElement.removeAttribute('data-hermes-glass'))
  expect(await tab.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
})

test('a sent prompt keeps its outline on the bubble while a reply streams', async ({ page }) => {
  await page.goto(`${url}?reasoning&light`)
  const row = page.getByTestId('first-transcript').locator('[data-slot="aui_user-message-root"]').first()
  const bubble = row.getByRole('button', { name: 'Edit message', exact: true })
  const actions = row.locator('[data-slot="aui_user-bubble-actions"]')
  await expect(bubble).toContainText('正在等待助手回复。')
  await bubble.hover()
  const stop = row.getByRole('button', { name: 'Stop', exact: true })
  await expect(stop).toBeVisible()
  await expect(bubble).toHaveCSS('border-top-style', 'solid')
  await expect(bubble).not.toHaveCSS('border-top-width', '0px')
  await expect(actions).toHaveCSS('box-shadow', 'none')

  const bubbleBounds = (await bubble.boundingBox())!
  const stopBounds = (await stop.boundingBox())!
  expect(stopBounds.x + stopBounds.width).toBeLessThan(bubbleBounds.x + bubbleBounds.width)
  expect(stopBounds.y + stopBounds.height).toBeLessThan(bubbleBounds.y + bubbleBounds.height)
})

test('sticky prompts clip scrolling replies without an opaque backing', async ({ page }) => {
  await page.goto(url)
  const transcript = page.getByTestId('first-transcript')
  const viewport = transcript.locator('[data-slot="aui_thread-viewport"]')
  const prompt = transcript.locator('[data-slot="aui_user-message-root"]').first()
  await expect(prompt).toBeAttached()
  expect(await prompt.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
  await page.evaluate(() => document.documentElement.style.setProperty('--user-bubble-keep', '0%'))

  await viewport.evaluate(el => {
    // End the initial bottom-follow before positioning the pinned prompt.
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }))
    el.scrollTop = 300
  })
  await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBe(300)

  const points = await prompt.evaluate(el => {
    const rect = el.getBoundingClientRect()
    const viewport = el.closest('[data-slot="aui_thread-viewport"]')!.getBoundingClientRect()

    return {
      x: Math.floor(rect.left + rect.width / 2),
      gap: Math.floor(viewport.top + 1),
      hidden: Math.floor(rect.top + 8),
      visible: Math.ceil(rect.bottom + 5)
    }
  })

  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const image = await page.screenshot({ omitBackground: true, path: test.info().outputPath('sticky-mask.png') })

  const colors = await page.evaluate(
    async ({ image, points }) => {
      const bitmap = new Image()
      bitmap.src = image
      await bitmap.decode()
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext('2d')!
      context.drawImage(bitmap, 0, 0)

      return [points.gap, points.hidden, points.visible].map(y =>
        Array.from(context.getImageData(points.x, y, 1, 1).data)
      )
    },
    { image: `data:image/png;base64,${image.toString('base64')}`, points }
  )

  expect(colors[0][3]).toBeLessThan(128)
  expect(colors[1][3]).toBeLessThan(128)
  expect(colors[2]).toEqual([255, 0, 0, 255])

  const clipEdge = () =>
    transcript
      .locator('[data-slot="aui_assistant-message-root"]')
      .first()
      .evaluate(el => {
        const rect = el.getBoundingClientRect()
        const clip = Number.parseFloat(getComputedStyle(el).getPropertyValue('--sticky-prompt-clip'))

        const prompt = el
          .closest('[data-slot="aui_message-group"]')!
          .querySelector('[data-slot="aui_user-message-root"]')!

        return Math.abs(rect.top + clip - prompt.getBoundingClientRect().bottom)
      })

  await expect.poll(clipEdge).toBeLessThan(1)

  const clips = await page.evaluate(async () => {
    const transcript = document.querySelector('[data-testid="first-transcript"]')!
    const read = () => {
      const reply = transcript.querySelector('[data-slot="aui_assistant-message-root"]')!
      const clipped = reply.closest('[data-sticky-prompt-clip]')

      return clipped ? getComputedStyle(clipped).clipPath : 'none'
    }
    const before = read()
    document.querySelector<HTMLButtonElement>('[data-testid="first-transcript-append"]')!.click()
    const samples = [read()]

    for (let i = 0; i < 3; i++) {
      await new Promise(requestAnimationFrame)
      samples.push(read())
    }

    return { before, samples }
  })

  expect(clips.before).not.toBe('none')
  expect(clips.samples.every(value => value !== 'none')).toBe(true)

  // Expanding a pinned prompt must move the clip without needing a scroll.
  await prompt.getByRole('button').click()
  await expect.poll(() => prompt.getByRole('button').evaluate(el => el.getBoundingClientRect().height)).toBe(140)
  await expect.poll(clipEdge).toBeLessThan(1)

  // A larger secondary-window titlebar offset moves both the sticky and clip.
  await viewport.evaluate(el => el.style.setProperty('--sticky-human-top', '55px'))
  await viewport.evaluate(el => {
    el.scrollTop = 301
  })
  await expect.poll(clipEdge).toBeLessThan(1)

  // Scroll back through attachments and out of the pinned state. Nothing may
  // remain clipped, and the other pane's independently pinned reply is intact.
  await viewport.evaluate(el => el.style.removeProperty('--sticky-human-top'))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await viewport.evaluate(el => {
    el.scrollTop = 0
  })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await expect.poll(() => transcript.locator('[data-sticky-prompt-clip]').count()).toBe(0)
  await expect(transcript.getByTestId('attachment').first()).toBeVisible()
  const other = page.getByTestId('second-transcript')
  expect(await other.locator('[data-slot="aui_thread-viewport"]').evaluate(el => el.scrollTop)).toBeGreaterThan(0)
  expect(await other.locator('[data-sticky-prompt-clip]').count()).toBeGreaterThan(0)

  // Enter another turn via a large jump (including virtualized history), then
  // return: stale clip styles must leave the previous turn.
  await viewport.evaluate(el => {
    el.scrollTop = 1400
  })
  await expect.poll(() => transcript.locator('[data-sticky-prompt-clip]').count()).toBeGreaterThan(0)
  await viewport.evaluate(el => {
    el.scrollTop = 0
  })
  await expect.poll(() => transcript.locator('[data-sticky-prompt-clip]').count()).toBe(0)

  // A standalone reply can still occupy the gap below a secondary titlebar
  // when the following prompt pins. It must be clipped across group boundaries.
  await page.goto(`${url}?preceding`)
  const gapViewport = page.getByTestId('first-transcript').locator('[data-slot="aui_thread-viewport"]')
  await gapViewport.locator('[data-slot="aui_user-message-root"]').first().waitFor({ state: 'attached' })
  await gapViewport.evaluate(el => {
    el.scrollTop = 0
  })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

  const gapScroll = await gapViewport.evaluate(el => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    el.style.setProperty('--sticky-human-top', '55px')
    const group = el.querySelector('[data-slot="aui_user-message-root"]')!.closest('[data-slot="aui_message-group"]')!
    const target = el.scrollTop + group.getBoundingClientRect().top - el.getBoundingClientRect().top - 45
    el.scrollTop = target

    return el.scrollTop
  })

  await expect.poll(() => gapViewport.evaluate(el => el.scrollTop)).toBe(gapScroll)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

  const gapClear = () =>
    gapViewport.evaluate(el => {
      const previous = el.querySelector('[data-slot="aui_assistant-message-root"]')!
      const bounds = el.getBoundingClientRect()
      const x = bounds.left + bounds.width / 2
      const hit = document.elementFromPoint(x, bounds.top + 34)

      return { hidden: !previous.contains(hit), clip: getComputedStyle(previous).clipPath }
    })

  await expect.poll(async () => (await gapClear()).hidden).toBe(true)
  expect((await gapClear()).clip).not.toBe('none')

  // Exercise the production message/edit components as well as the colored
  // clipping markers. Editing replaces the prompt with a display:contents root.
  await page.goto(`${url}?real`)
  const realViewport = page.getByTestId('first-transcript').locator('[data-slot="aui_thread-viewport"]')
  await realViewport.locator('[data-slot="aui_assistant-message-root"]').first().waitFor()
  await realViewport
    .locator('[data-slot="aui_assistant-message-root"]')
    .first()
    .evaluate(el => {
      el.style.height = '900px'
    })
  await realViewport.evaluate(el => {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }))
    el.scrollTop = 300
  })
  const realPrompt = realViewport.locator('[data-slot="aui_user-message-root"]').first()
  await realPrompt.getByRole('button', { name: 'Edit message', exact: true }).click()
  const editor = realViewport.getByRole('textbox', { name: 'Edit message', exact: true })
  await expect(editor).toBeVisible()
  const radii = await editor.evaluate(el => [
    getComputedStyle(el.parentElement!).borderRadius,
    getComputedStyle(el.closest('[data-glass-raised]')!).borderRadius
  ])
  expect(radii[0]).toBe(radii[1])
  await editor.fill('Expanded editable prompt\n'.repeat(8))
  await realViewport.evaluate(el => {
    el.scrollTop = 400
  })
  await expect
    .poll(() =>
      realViewport
        .locator('[data-slot="aui_assistant-message-root"]')
        .first()
        .evaluate(el => {
          const prompt = el
            .closest('[data-slot="aui_message-group"]')!
            .querySelector('[data-slot="aui_user-message-root"]')!

          return Math.abs(
            el.getBoundingClientRect().top +
              Number.parseFloat(getComputedStyle(el).getPropertyValue('--sticky-prompt-clip')) -
              prompt.getBoundingClientRect().bottom
          )
        })
    )
    .toBeLessThan(1)
})

import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { isElementInHiddenPane, PANE_HIDDEN_ATTR } from '@/components/pane-shell/pane-visibility'
import { $layoutTree } from '@/components/pane-shell/tree/store'
import { markRightPanePerf } from '@/debug/right-pane-events'
import { createRendererLoopPauseController } from '@/lib/renderer-loop-pause'
import { $paneStates } from '@/store/panes'

import { $terminalTakeover } from '../store'

import { ensureTerminal } from './terminals'
import { TerminalWorkspace } from './workspace'

/**
 * One xterm Terminal mounted at the layout root and CSS-overlayed onto
 * whichever `<TerminalSlot />` is active. Moving the host DOM detaches xterm's
 * WebGL renderer (it observes its own attachment) and resets the screen, so
 * the host stays put and we chase the slot's bounding rect with position:fixed.
 */

const $slot = atom<HTMLElement | null>(null)

const SLOT_CLASS = 'relative flex min-h-0 min-w-0 flex-1 flex-col'

export function TerminalSlot({ className = SLOT_CLASS }: { className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = ref.current

    if (!el) {
      return
    }

    $slot.set(el)

    return () => {
      if ($slot.get() === el) {
        $slot.set(null)
      }
    }
  }, [])

  return <div className={className} data-terminal-slot="" ref={ref} />
}

interface PersistentTerminalProps {
  onAddSelectionToChat: (text: string, label?: string) => void
}

interface Rect {
  hidden: boolean
  top: number
  left: number
  width: number
  height: number
  clipPath?: string
}

interface SlotRect extends Rect {
  slot: HTMLElement
}

const sameRect = (a: Rect | null, b: Rect) =>
  !!a &&
  a.hidden === b.hidden &&
  a.top === b.top &&
  a.left === b.left &&
  a.width === b.width &&
  a.height === b.height &&
  a.clipPath === b.clipPath

function measureSlot(slot: HTMLElement, frame: HTMLElement | null): Rect {
  const r = slot.getBoundingClientRect()
  const hidden = isElementInHiddenPane(slot)
  if (!frame) {
    // Standalone slots cover their full pixel footprint.
    const top = Math.floor(r.top)
    const left = Math.floor(r.left)
    return { hidden, top, left, width: Math.ceil(r.right) - left, height: Math.ceil(r.bottom) - top }
  }

  // The fixed xterm host lives outside the pane's overflow clip. Reproduce
  // its rounded padding edge in slot coordinates, including the parts behind
  // the tab strip and terminal rail. Keep subpixel edges aligned at any zoom.
  const pane = frame.getBoundingClientRect()
  const style = getComputedStyle(frame)
  const stroke = parseFloat(style.borderLeftWidth)
  const radius = Math.max(0, parseFloat(style.borderTopLeftRadius) - stroke)
  const insets = [pane.top - r.top, r.right - pane.right, r.bottom - pane.bottom, pane.left - r.left]
  const clipPath = `inset(${insets.map(inset => `${inset + stroke}px`).join(' ')} round ${radius}px)`
  return { hidden, top: r.top, left: r.left, width: r.width, height: r.height, clipPath }
}

export function PersistentTerminal({ onAddSelectionToChat }: PersistentTerminalProps) {
  const slot = useStore($slot)
  const terminalTakeover = useStore($terminalTakeover)
  const [rect, setRect] = useState<SlotRect | null>(null)
  const [ready, setReady] = useState(false)

  // VS Code parity: once the pane has ever been opened, keep the terminals
  // mounted — and their shells alive — even while hidden. Hiding the pane just
  // collapses the slot, so the overlay below goes invisible; nothing is torn
  // down. Only an explicit per-tab close kills a PTY. Re-opening re-ensures one
  // terminal exists (covers having closed the last tab).
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    if (terminalTakeover && ready) {
      setMounted(true)
      ensureTerminal()
    }
  }, [terminalTakeover, ready])

  useLayoutEffect(() => {
    if (!slot) {
      setRect(null)

      return
    }

    let prev: Rect | null = null
    let frame = 0
    let stopped = false
    let pendingReason = 'initial'
    let pauseController: ReturnType<typeof createRendererLoopPauseController> | null = null
    const paneFrame = slot.closest<HTMLElement>('[data-pane-frame]')

    const rendererPaused = () => pauseController?.isPaused() ?? document.visibilityState === 'hidden'

    const cancelFrame = () => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame)
        frame = 0
      }
    }

    const updateRect = (next: Rect) => {
      prev = next
      setRect({ ...next, slot })
    }

    // Stop painting and intercepting input as soon as the pane goes away.
    // Only a fresh measurement may make the overlay visible again.
    const hideOverlay = () => {
      if (prev && !prev.hidden) {
        updateRect({ ...prev, hidden: true })
      }
    }

    const measure = (reason: string): boolean => {
      if (rendererPaused()) {
        hideOverlay()

        return false
      }

      markRightPanePerf('terminal-measure', reason)
      const next = measureSlot(slot, paneFrame)

      if (!sameRect(prev, next)) {
        updateRect(next)

        if (next.width > 0 && next.height > 0) {
          setReady(true)
        }

        return true
      }

      return false
    }

    const scheduleMeasure = (reason = 'unknown') => {
      if (stopped) {
        return
      }

      const paused = rendererPaused()
      if (paused || isElementInHiddenPane(slot)) {
        hideOverlay()
      }

      if (paused || frame !== 0) {
        return
      }

      pendingReason = reason
      frame = window.requestAnimationFrame(() => {
        frame = 0
        const reason = pendingReason

        if (measure(reason)) {
          scheduleMeasure('settle')
        }
      })
    }

    const handleVisibilityChange = () => {
      if (rendererPaused()) {
        cancelFrame()
        hideOverlay()

        return
      }

      scheduleMeasure('visibility')
    }

    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            scheduleMeasure('resize-observer')
          })

    const positionObserver =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            scheduleMeasure('ancestor-mutation')
          })

    // Startup can restore the window and pane bounds before it gets focus.
    // Track visible windows, and pause only when hidden or minimized.
    pauseController = createRendererLoopPauseController(handleVisibilityChange)

    if (measure('initial')) {
      scheduleMeasure('settle')
    }

    observer?.observe(slot)
    if (paneFrame) {
      observer?.observe(paneFrame)
    }

    const handleScroll = () => scheduleMeasure('scroll')
    const scrollTargets: Array<HTMLElement | Window> = [window]
    window.addEventListener('scroll', handleScroll)

    for (let node: HTMLElement | null = slot; node; node = node.parentElement) {
      positionObserver?.observe(node, {
        attributeFilter: ['class', 'style', 'dir', 'hidden', 'aria-hidden', 'data-state', PANE_HIDDEN_ATTR],
        attributes: true,
        childList: true,
        subtree: false
      })
      // Scroll does not bubble. Listen only on the slot's own ancestor chain,
      // so a transcript/file-tree/xterm viewport scroll elsewhere cannot wake
      // terminal positioning.
      node.addEventListener('scroll', handleScroll)
      scrollTargets.push(node)
    }

    // Nested layout-tree and pane-state commits can move the slot without
    // changing its own size. Subscribe to the actual layout authorities instead
    // of observing every descendant mutation under every ancestor (chat stream
    // and file-tree updates are unrelated and used to wake this tracker).
    const unsubscribeLayout = $layoutTree.listen(() => scheduleMeasure('layout-tree'))
    const unsubscribePanes = $paneStates.listen(() => scheduleMeasure('pane-state'))

    const handleResize = () => scheduleMeasure('window-resize')

    window.addEventListener('resize', handleResize)

    return () => {
      stopped = true
      cancelFrame()
      observer?.disconnect()
      positionObserver?.disconnect()
      unsubscribeLayout()
      unsubscribePanes()
      window.removeEventListener('resize', handleResize)
      scrollTargets.forEach(target => target.removeEventListener('scroll', handleScroll))
      pauseController?.dispose()
    }
  }, [slot])

  const visible = Boolean(rect && rect.slot === slot && !rect.hidden && rect.width > 0 && rect.height > 0)

  const style: CSSProperties = {
    position: 'fixed',
    top: rect?.top ?? 0,
    left: rect?.left ?? 0,
    width: rect?.width ?? 0,
    height: rect?.height ?? 0,
    clipPath: rect?.clipPath,
    display: 'flex',
    flexDirection: 'column',
    visibility: visible ? 'visible' : 'hidden',
    // Electron may keep xterm's WebGL canvas visually composited after an
    // ancestor becomes visibility:hidden. Opacity clears that compositor layer
    // while preserving the mounted DOM, terminal dimensions, and live PTY.
    opacity: visible ? 1 : 0,
    pointerEvents: visible ? 'auto' : 'none',
    zIndex: 4,
    // The framed pane paints the padding once, including its antialiased corners.
    backgroundColor: rect?.clipPath ? undefined : 'var(--ui-terminal-surface-background)',
    contain: 'layout size paint'
  }

  // Defer the FIRST mount until the pane is open and the slot has real dims —
  // booting xterm/node-pty at 0×0 starts the shell at 80×24 and spawns a visible
  // conhost on Windows. After that `mounted` latches: shells persist while hidden.
  return (
    <div aria-hidden={!visible} data-persistent-terminal="" style={style}>
      {mounted && <TerminalWorkspace onAddSelectionToChat={onAddSelectionToChat} />}
    </div>
  )
}

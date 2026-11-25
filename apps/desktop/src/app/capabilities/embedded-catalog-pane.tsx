import { useStore } from '@nanostores/react'
import { type ReactNode, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { $paneHeightOverride, setPaneHeightOverride } from '@/store/panes'

const DEFAULT_HEIGHT = 380
const MIN_HEIGHT = 120
const MAX_VIEWPORT_RATIO = 0.75
const COLLAPSED_HEIGHT = 4
const LIST_RESERVED_HEIGHT = 176

interface EmbeddedCatalogPaneProps {
  actions?: ReactNode
  browseLabel: string
  hidden?: boolean
  hideLabel: string
  hint: string
  onMessage: (event: MessageEvent) => void
  paneId: string
  src: string
  title: string
}

export function EmbeddedCatalogPane({
  actions,
  browseLabel,
  hidden,
  hideLabel,
  hint,
  onMessage,
  paneId,
  src,
  title
}: EmbeddedCatalogPaneProps) {
  const heightOverride = useStore($paneHeightOverride(paneId))
  const height = heightOverride ?? DEFAULT_HEIGHT
  const open = height > COLLAPSED_HEIGHT
  const [mounted, setMounted] = useState(open)
  const [dragging, setDragging] = useState(false)
  const sectionRef = useRef<HTMLElement>(null)

  // Retain the catalog's search and scroll position when it is collapsed.
  if (open && !mounted) {
    setMounted(true)
  }

  useEffect(() => {
    if (!open || hidden) {
      return undefined
    }

    window.addEventListener('message', onMessage)

    return () => window.removeEventListener('message', onMessage)
  }, [hidden, onMessage, open])

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }

    event.preventDefault()
    const startY = event.clientY
    const column = sectionRef.current?.parentElement
    const columnMax = column ? column.clientHeight - LIST_RESERVED_HEIGHT : Number.POSITIVE_INFINITY
    const max = Math.max(MIN_HEIGHT, Math.round(Math.min(window.innerHeight * MAX_VIEWPORT_RATIO, columnMax)))
    setDragging(true)

    const onMove = (move: globalThis.PointerEvent) => {
      setPaneHeightOverride(paneId, Math.round(Math.min(max, Math.max(MIN_HEIGHT, height + startY - move.clientY))))
    }

    const stopDrag = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stopDrag)
      window.removeEventListener('pointercancel', stopDrag)
      setDragging(false)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stopDrag)
    window.addEventListener('pointercancel', stopDrag)
  }

  return (
    <section
      className={cn(
        'relative flex min-h-9 flex-col overflow-hidden border-t border-(--ui-stroke-secondary)',
        hidden && 'hidden'
      )}
      ref={sectionRef}
    >
      <div
        className="group/sash absolute inset-x-0 top-0 z-10 h-1 -translate-y-1/2 cursor-row-resize"
        data-testid={`${paneId}-sash`}
        onDoubleClick={() => setPaneHeightOverride(paneId, undefined)}
        onPointerDown={startDrag}
      >
        <div
          className={cn(
            'absolute inset-x-0 top-1/2 h-px -translate-y-1/2 transition-colors',
            dragging ? 'bg-(--ui-stroke-secondary)' : 'group-hover/sash:bg-(--ui-stroke-secondary)'
          )}
        />
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 px-3 py-1.5">
        <span className="text-xs font-semibold text-(--ui-text-secondary)">{title}</span>
        <div className="flex items-center gap-1">
          {actions}
          <Button
            aria-expanded={open}
            onClick={() => setPaneHeightOverride(paneId, open ? 0 : undefined)}
            size="xs"
            type="button"
            variant="text"
          >
            {open ? hideLabel : browseLabel}
          </Button>
        </div>
      </div>
      {mounted && (
        <div className={cn('flex min-h-0 flex-col gap-1 px-3 pb-2', !open && 'hidden')}>
          <div
            className="relative min-h-0 w-full overflow-hidden rounded-lg border border-(--ui-stroke-secondary)"
            style={{ flex: `0 1 ${height}px` }}
          >
            {/* Scale the document inside the frame for a denser view of the catalog. */}
            <iframe
              className={cn(
                'absolute inset-0 size-[133.333%] origin-top-left scale-75 border-0',
                dragging && 'pointer-events-none'
              )}
              sandbox="allow-scripts allow-same-origin"
              src={src}
              title={title}
            />
          </div>
          <p className="shrink-0 px-1 text-2xs leading-4 text-(--ui-text-quaternary)">{hint}</p>
        </div>
      )}
    </section>
  )
}

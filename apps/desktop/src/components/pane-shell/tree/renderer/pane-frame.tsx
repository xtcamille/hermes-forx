import type { ReactNode } from 'react'

import { TITLEBAR_DRAG_HANDLE_WIDTH, TITLEBAR_HEIGHT } from '@/app/shell/titlebar'
import { cn } from '@/lib/utils'

interface PaneFrameProps {
  children: ReactNode
  header: ReactNode
  tabsInTitlebar: boolean
  topEdge: boolean
}

export function PaneFrame({ children, header, tabsInTitlebar, topEdge }: PaneFrameProps) {
  const nativeTabs = tabsInTitlebar && Boolean(header)

  return (
    <>
      {topEdge && (
        <div className="flex min-w-0 shrink-0" data-window-titlebar-band="" style={{ height: TITLEBAR_HEIGHT }}>
          <div aria-hidden className="shrink-0" style={{ width: 'var(--panel-titlebar-left, 100%)' }} />
          {nativeTabs && header}
          {/* Overflowing tabs must leave a draggable part of the window outside the tablist. */}
          <div
            aria-hidden
            className={cn('[-webkit-app-region:drag]', nativeTabs ? 'shrink-0' : 'min-w-0 flex-1')}
            data-window-drag-handle=""
            style={{ width: nativeTabs ? TITLEBAR_DRAG_HANDLE_WIDTH : undefined }}
          />
          <div aria-hidden className="shrink-0" style={{ width: 'var(--panel-titlebar-right, 0px)' }} />
        </div>
      )}
      <div
        className={cn(
          'relative flex min-h-0 min-w-0 flex-1 flex-col bg-(--ui-editor-surface-background)',
          topEdge && 'mt-(--pane-gap)'
        )}
        data-pane-frame=""
      >
        {header && !nativeTabs && (
          <div className="flex min-w-0 shrink-0 bg-(--ui-sidebar-surface-background)" data-panel-header="">
            {header}
          </div>
        )}
        {children}
      </div>
    </>
  )
}

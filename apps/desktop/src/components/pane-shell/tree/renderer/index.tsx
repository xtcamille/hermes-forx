/**
 * Layout tree renderer (root).
 *
 * - `split` -> flex row/column; gutters between siblings are resize sashes. See
 *   tree-split.tsx.
 * - `group` -> a ZONE: header strip (tabs when stacked, minimize chevron) +
 *   the active pane's content, resolved from the contribution registry
 *   (`area: 'panes'`). Empty zones exist only in editor-authored trees. See
 *   tree-group.tsx.
 *
 * Dragging is FancyZones-style (drag-session.ts): the LAYOUT STAYS FIXED and
 * every zone lights up as a whole-region drop target; dropping moves the pane
 * into that zone (joining its tab stack). Structure changes (splitting/merging/
 * resizing zones) belong to the zone editor, not the drag.
 *
 * This file owns only the composition: the recursive tree, the narrow-viewport
 * overlays, the edit palette, and the zone editor. The pieces live in sibling
 * modules — track-model (sizing), drag-session (drag), tree-split / tree-group
 * (nodes), layout-picker + edit-bar (edit mode), narrow-overlays.
 */

import { useStore } from '@nanostores/react'
import { type CSSProperties, type ReactNode, useEffect } from 'react'

import { TITLEBAR_HEIGHT } from '@/app/shell/titlebar'

import { useLayoutEditHotkey } from '../../edit-mode'
import { publishWorkspaceGeometry } from '../../geometry'
import { $layoutTree, trackActiveTreeGroup } from '../store'
import { useTabKeyHints } from '../tab-key-hint-state'
import { ZoneEditor } from '../zone-editor'

import { TreeEditBar } from './edit-bar'
import { FloatingPanes } from './floating-panes'
import { NarrowOverlays } from './narrow-overlays'
import { TreeNode } from './tree-node'

export function LayoutTreeRoot({ children, titlebar = false }: { children?: ReactNode; titlebar?: boolean }) {
  const tree = useStore($layoutTree)

  useLayoutEditHotkey(true)
  useTabKeyHints()
  // Track the interacted zone so ⌘W closes the right tab even when nothing is
  // DOM-focused.
  useEffect(trackActiveTreeGroup, [])
  // Publish --workspace-left/right so chrome (titlebar title) aligns to the
  // main pane's geometry in plain CSS.
  useEffect(publishWorkspaceGeometry, [])

  if (!tree) {
    return null
  }

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 bg-(--ui-pane-gutter) px-(--pane-gap) pb-(--pane-gap)"
      style={
        {
          '--pane-window-band': `${titlebar ? TITLEBAR_HEIGHT : 0}px`,
          paddingTop: titlebar ? 0 : 'var(--pane-gap)'
        } as CSSProperties
      }
    >
      {/* Docked panes and narrow drawers share a frame. Their content can
          also render standalone, where it supplies its own edge chrome. */}
      <style>{`
        [data-pane-frame] :is(aside, [data-slot=sidebar]) {
          border-left-width: 0;
          border-right-width: 0;
          box-shadow: none;
        }
        /* Old-shell titlebar BANDS (chat's session header et al size to
           --titlebar-height, which is 0 inside zones): a zero-height band is
           non-functional but still paints its border-b — a stray hairline
           doubling the zone's top seam. Remove the band entirely. */
        [data-tree-group] header[class*="h-(--titlebar-height)"] {
          display: none;
        }
      `}</style>
      <TreeNode
        leftEdge={titlebar}
        node={tree}
        rightEdge={titlebar}
        root
        rootRow={tree.type === 'split' && tree.orientation === 'row'}
        topEdge={titlebar}
      />
      <NarrowOverlays />
      {/* Non-tiling panes: fixed cards above the tree, outside every zone. */}
      <FloatingPanes />
      <TreeEditBar />
      <ZoneEditor />
      {children}
    </div>
  )
}

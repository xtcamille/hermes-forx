/**
 * Desktop preview read bridge. The browser and text file panes register
 * readers by tab id. This module picks the active tab and pages its text.
 */

import { $rightRailActiveTabId } from '@/store/layout'
import { $previewTabs } from '@/store/preview'

import { nudgeOverlay } from './preview-nudge'

export interface PreviewReadOptions {
  /** Characters to return from `start` (capped at PREVIEW_READ_MAX_CHARS). */
  count?: number
  /** 0-indexed character offset into the preview text. */
  start?: number
}

export interface PreviewReadResult {
  end: number
  kind: string
  note?: string
  path?: string
  start: number
  text: string
  title: string
  total_chars: number
  url: string
}

interface PreviewPage {
  note?: string
  text: string
  title?: string
  url?: string
}

type PageReader = () => Promise<PreviewPage | null>

/** Default + hard cap on one read — a page's innerText can be megabytes, and
 *  this crosses the gateway into model context. Page with start/count. */
export const PREVIEW_READ_MAX_CHARS = 24_000

const readers = new Map<string, PageReader>()

/** Register a live preview's page reader; returns an idempotent unregister. */
export function registerPreviewPageReader(tabId: string, reader: PageReader): () => void {
  readers.set(tabId, reader)

  return () => {
    if (readers.get(tabId) === reader) {
      readers.delete(tabId)
    }
  }
}

function windowText(
  base: Omit<PreviewReadResult, 'end' | 'start' | 'text' | 'total_chars'>,
  text: string,
  opts: PreviewReadOptions
): PreviewReadResult {
  const total = text.length
  const from = Math.max(0, Math.min(opts.start ?? 0, total))
  const want = Math.min(Math.max(1, opts.count ?? PREVIEW_READ_MAX_CHARS), PREVIEW_READ_MAX_CHARS)
  const to = Math.max(from, Math.min(from + want, total))

  return { ...base, end: to, start: from, text: text.slice(from, to), total_chars: total }
}

/** Read the ACTIVE preview tab. Null only when no tab is open at all. */
export async function readActivePreview(opts: PreviewReadOptions = {}): Promise<PreviewReadResult | null> {
  const tabs = $previewTabs.get()
  const tab = tabs.find(t => t.id === $rightRailActiveTabId.get()) ?? tabs[0]

  if (!tab) {
    return null
  }

  const { target } = tab
  const reader = readers.get(tab.id)

  if (reader) {
    try {
      const page = await reader()

      if (page && readers.get(tab.id) === reader) {
        nudgeOverlay('read')

        return windowText(
          {
            kind: target.kind,
            ...(page.note ? { note: page.note } : {}),
            path: target.path,
            title: page.title || target.label,
            url: page.url || target.url
          },
          page.text,
          opts
        )
      }
    } catch {
      // A webview can be replaced during a read. Return its tab identity below.
    }
  }

  return windowText(
    {
      kind: target.kind,
      note:
        target.kind === 'file'
          ? 'File preview text is unavailable. For a text file, retry once the content appears in the pane.'
          : target.kind === 'artifact'
            ? 'Generated artifact — its content is in the conversation that produced it.'
            : 'The page has not finished loading — retry in a moment.',
      path: target.path,
      title: target.label,
      url: target.url
    },
    '',
    opts
  )
}

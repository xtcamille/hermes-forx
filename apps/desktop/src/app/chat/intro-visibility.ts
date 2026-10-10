/**
 * Whether the empty-chat intro splash renders.
 *
 * The splash is the empty state of a conversation: Logo, BrandMark, and
 * guidance copy. It renders on any empty conversation (fresh drafts,
 * new session tabs, or empty sessions), unless disabled by the user's
 * Appearance toggle (`enabled`), running in an auxiliary window (compact scratch),
 * or owned by a companion bot with its own empty-chat state (Bot Mode).
 *
 * `enabled` is the user's Appearance toggle and outranks every other clause:
 * turning the splash off never depends on which window asks.
 */
export function shouldShowIntro(input: {
  activeSessionId?: null | string
  auxiliaryWindow: boolean
  enabled: boolean
  freshDraftReady?: boolean
  isBotChat?: boolean
  messagesEmpty: boolean
  primary?: boolean
  routedSessionView?: boolean
  selectedSessionId?: null | string
}): boolean {
  return (
    input.enabled &&
    !input.auxiliaryWindow &&
    input.messagesEmpty &&
    !input.isBotChat
  )
}


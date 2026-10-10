import { describe, expect, it } from 'vitest'

import { shouldShowIntro } from './intro-visibility'

const showing = {
  activeSessionId: null,
  auxiliaryWindow: false,
  enabled: true,
  freshDraftReady: true,
  messagesEmpty: true,
  primary: true,
  routedSessionView: false,
  selectedSessionId: null
} as const

describe('shouldShowIntro', () => {
  it('shows on a fresh draft in the primary window', () => {
    expect(shouldShowIntro(showing)).toBe(true)
  })

  it('hides when the Appearance toggle is off', () => {
    expect(shouldShowIntro({ ...showing, enabled: false })).toBe(false)
  })

  it('keeps the toggle authoritative over every other clause', () => {
    // Off means off: no window, session, or draft state re-enables the splash.
    const inputs = [
      { ...showing, auxiliaryWindow: true, enabled: false },
      { ...showing, enabled: false, freshDraftReady: false },
      { ...showing, enabled: false, primary: false },
      { ...showing, enabled: false, messagesEmpty: false }
    ]

    for (const input of inputs) {
      expect(shouldShowIntro(input)).toBe(false)
    }
  })

  it('shows on new session tabs and empty session tiles', () => {
    expect(
      shouldShowIntro({
        ...showing,
        primary: false,
        routedSessionView: true,
        selectedSessionId: 'session-1',
        activeSessionId: 'runtime-1',
        freshDraftReady: false
      })
    ).toBe(true)
  })

  it('hides when messages are not empty or auxiliary window or bot chat', () => {
    expect(shouldShowIntro({ ...showing, messagesEmpty: false })).toBe(false)
    expect(shouldShowIntro({ ...showing, auxiliaryWindow: true })).toBe(false)
    expect(shouldShowIntro({ ...showing, isBotChat: true })).toBe(false)
  })
})

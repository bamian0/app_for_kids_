import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INTRO_VERSION, hasSeenIntro, markIntroSeen, resetIntroSessionForTests } from './introFlag.ts'

/** A Storage-like map, as the browser gives it (the tests run in Node, which has none). */
function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  }
}

/** Private mode on older Safari, or site data blocked: every access throws. */
function blockedStorage(): Storage {
  const fail = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  }
  return { length: 0, clear: fail, getItem: fail, key: fail, removeItem: fail, setItem: fail }
}

describe('intro flag', () => {
  beforeEach(() => resetIntroSessionForTests())
  afterEach(() => vi.unstubAllGlobals())

  it('is unseen on a fresh device and seen once marked, across launches', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    expect(hasSeenIntro()).toBe(false)
    markIntroSeen()
    expect(hasSeenIntro()).toBe(true)
    expect(storage.getItem('stakes.introSeen')).toBe(String(INTRO_VERSION))
    // Next launch: only storage remembers.
    resetIntroSessionForTests()
    expect(hasSeenIntro()).toBe(true)
  })

  it('shows again for an older intro version or a garbled value', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    storage.setItem('stakes.introSeen', String(INTRO_VERSION - 1))
    expect(hasSeenIntro()).toBe(false)
    storage.setItem('stakes.introSeen', 'yes')
    expect(hasSeenIntro()).toBe(false)
  })

  it('never throws when storage is blocked, and stays dismissed for the session', () => {
    vi.stubGlobal('localStorage', blockedStorage())
    expect(hasSeenIntro()).toBe(false)
    expect(() => markIntroSeen()).not.toThrow()
    expect(hasSeenIntro()).toBe(true)
    // Nothing was saved, so the next launch shows it again.
    resetIntroSessionForTests()
    expect(hasSeenIntro()).toBe(false)
  })

  it('treats a missing localStorage like a blocked one', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(hasSeenIntro()).toBe(false)
    expect(() => markIntroSeen()).not.toThrow()
    expect(hasSeenIntro()).toBe(true)
  })
})

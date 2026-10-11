import { afterEach, describe, expect, it, vi } from 'vitest'
import { isTextField, keyboardInset, revealScrollTop, trackKeyboard } from './keyboard.ts'

const still = { offsetTop: 0, scale: 1 }

describe('keyboardInset', () => {
  it('is the part of the layout viewport below the visual viewport', () => {
    // iPhone 15: 844pt tall, keyboard with QuickType ≈ 336pt.
    expect(keyboardInset(844, { ...still, height: 508 })).toBe(336)
  })

  it('shrinks while iOS pans the shell up, and recovers once the pan is undone', () => {
    expect(keyboardInset(844, { height: 508, offsetTop: 120, scale: 1 })).toBe(216)
    expect(keyboardInset(844, { height: 508, offsetTop: 0, scale: 1 })).toBe(336)
  })

  it('is 0 without a keyboard, for rounding noise and while pinch-zoomed', () => {
    expect(keyboardInset(844, { ...still, height: 844 })).toBe(0)
    expect(keyboardInset(844, { ...still, height: 842.6 })).toBe(0)
    expect(keyboardInset(844, { height: 422, offsetTop: 100, scale: 2 })).toBe(0)
    // Android resizes the layout viewport itself, so both heights shrink together.
    expect(keyboardInset(508, { ...still, height: 508 })).toBe(0)
  })
})

describe('revealScrollTop', () => {
  const visible = { top: 99, bottom: 508 }

  it('scrolls a field hidden under the keyboard up to just above it', () => {
    expect(revealScrollTop(0, { top: 560, bottom: 604 }, visible)).toBe(108)
  })

  it('scrolls a field hidden under the nav bar down below it', () => {
    expect(revealScrollTop(300, { top: 60, bottom: 104 }, visible)).toBe(249)
  })

  it('leaves a visible field alone', () => {
    expect(revealScrollTop(40, { top: 200, bottom: 244 }, visible)).toBeNull()
  })

  it('aligns the top of a field taller than the visible area', () => {
    expect(revealScrollTop(0, { top: 300, bottom: 900 }, visible)).toBe(189)
  })
})

describe('isTextField', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, ...extra }) as unknown as Element
  it('is true for text inputs, textareas and contenteditable', () => {
    expect(isTextField(el('INPUT', { type: 'text' }))).toBe(true)
    expect(isTextField(el('INPUT', { type: 'email' }))).toBe(true)
    expect(isTextField(el('TEXTAREA'))).toBe(true)
    expect(isTextField(el('DIV', { isContentEditable: true }))).toBe(true)
  })
  it('is false for switches, buttons and nothing', () => {
    expect(isTextField(el('INPUT', { type: 'checkbox' }))).toBe(false)
    expect(isTextField(el('BUTTON'))).toBe(false)
    expect(isTextField(null)).toBe(false)
  })
})

describe('trackKeyboard', () => {
  afterEach(() => vi.unstubAllGlobals())

  function setup(focused: Element | null) {
    const listeners = new Map<string, () => void>()
    const vv = {
      height: 844,
      offsetTop: 0,
      scale: 1,
      addEventListener: (type: string, fn: () => void) => listeners.set(`vv:${type}`, fn),
      removeEventListener: (type: string) => listeners.delete(`vv:${type}`),
    }
    const frames: Array<() => void> = []
    const scrollTo = vi.fn(() => {
      vv.offsetTop = 0
    })
    vi.stubGlobal('window', {
      visualViewport: vv,
      innerHeight: 844,
      scrollY: 0,
      scrollTo,
      addEventListener: () => {},
      removeEventListener: () => {},
    })
    vi.stubGlobal('document', { activeElement: focused, addEventListener: () => {}, removeEventListener: () => {} })
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => frames.push(fn))
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const vars = new Map<string, string>()
    const attrs = new Set<string>()
    const root = {
      style: { setProperty: (k: string, v: string) => vars.set(k, v), removeProperty: (k: string) => vars.delete(k) },
      toggleAttribute: (name: string, on: boolean) => (on ? attrs.add(name) : attrs.delete(name)),
      removeAttribute: (name: string) => attrs.delete(name),
    } as unknown as HTMLElement
    // The reveal pass finds no scroller on these fakes and does nothing.
    const flush = () => {
      while (frames.length) frames.shift()!()
    }
    return { vv, listeners, scrollTo, vars, attrs, root, flush }
  }

  it('publishes the inset and cancels the iOS pan while a field is focused', () => {
    const field = { tagName: 'INPUT', type: 'text' } as unknown as Element
    const t = setup(field)
    const stop = trackKeyboard(t.root)
    expect(t.vars.get('--keyboard-inset')).toBe('0px')
    expect(t.attrs.has('data-keyboard')).toBe(false)

    // Keyboard up, and iOS has panned the visual viewport 120px down the fixed shell.
    t.vv.height = 508
    t.vv.offsetTop = 120
    t.listeners.get('vv:scroll')!()
    t.flush()
    expect(t.scrollTo).toHaveBeenCalledWith(0, 0)
    expect(t.vars.get('--keyboard-inset')).toBe('336px')
    expect(t.attrs.has('data-keyboard')).toBe(true)

    // Keyboard down again.
    t.vv.height = 844
    t.listeners.get('vv:resize')!()
    t.flush()
    expect(t.vars.get('--keyboard-inset')).toBe('0px')
    expect(t.attrs.has('data-keyboard')).toBe(false)

    stop()
    expect(t.vars.has('--keyboard-inset')).toBe(false)
    expect(t.listeners.size).toBe(0)
  })

  it('leaves the viewport alone when nothing is being typed (pinch zoom, scrolling)', () => {
    const t = setup(null)
    trackKeyboard(t.root)
    t.vv.height = 422
    t.vv.offsetTop = 200
    t.vv.scale = 2
    t.listeners.get('vv:scroll')!()
    t.flush()
    expect(t.scrollTo).not.toHaveBeenCalled()
    expect(t.vars.get('--keyboard-inset')).toBe('0px')
  })
})

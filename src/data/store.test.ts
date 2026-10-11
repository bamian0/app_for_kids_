import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Live } from './api.ts'
import { forget, forgetWhere, peek, watch, type Emit } from './store.ts'

const refused: Live<string> = { data: undefined, loading: false, error: new Error('You don’t have access to this.') }

/** A fake listener: each start is one "run" the test drives by hand. */
function fakeSource() {
  const runs: { emit: Emit<string>; stopped: boolean }[] = []
  const start = (emit: Emit<string>) => {
    const run = { emit, stopped: false }
    runs.push(run)
    return () => {
      run.stopped = true
    }
  }
  return { runs, start }
}

describe('shared listeners', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('restarts a refused listener quietly, without flashing the error', () => {
    const source = fakeSource()
    const seen: Live<string>[] = []
    const release = watch('k1', source.start, () => seen.push(peek<string>('k1')))

    source.runs[0].emit(refused)
    expect(peek('k1').loading).toBe(true)
    expect(seen).toEqual([])

    vi.advanceTimersByTime(1_000)
    expect(source.runs).toHaveLength(2)
    expect(source.runs[0].stopped).toBe(true)
    source.runs[1].emit({ data: 'ok', loading: false, error: null })
    expect(peek<string>('k1').data).toBe('ok')
    release()
  })

  it('shows a lasting refusal and keeps retrying with backoff', () => {
    const source = fakeSource()
    const release = watch('k2', source.start, () => {})
    source.runs[0].emit(refused)
    vi.advanceTimersByTime(1_000)
    source.runs[1].emit(refused)
    expect(peek('k2').error).not.toBeNull()
    vi.advanceTimersByTime(2_999)
    expect(source.runs).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(source.runs).toHaveLength(3)
    release()
  })

  it('stops retrying once nobody watches', () => {
    const source = fakeSource()
    const release = watch('k3', source.start, () => {})
    source.runs[0].emit(refused)
    release()
    vi.advanceTimersByTime(20_000)
    expect(source.runs.every((r) => r.stopped)).toBe(true)
    vi.advanceTimersByTime(120_000)
    expect(source.runs.length).toBeLessThanOrEqual(2)
    expect(source.runs.every((r) => r.stopped)).toBe(true)
  })
})

describe('forget', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('restarts a watched entry from loading, so a stale "no access" is not reused', () => {
    const source = fakeSource()
    let changes = 0
    const release = watch('f1', source.start, () => changes++)
    source.runs[0].emit({ data: 'gone', loading: false, error: null })
    forget('f1')
    expect(source.runs[0].stopped).toBe(true)
    expect(source.runs).toHaveLength(2)
    expect(peek('f1').loading).toBe(true)
    source.runs[1].emit({ data: 'joined', loading: false, error: null })
    expect(peek<string>('f1').data).toBe('joined')
    expect(changes).toBe(3)
    release()
  })

  it('discards a lingering entry, so the next watcher starts fresh', () => {
    const source = fakeSource()
    const release = watch('f2', source.start, () => {})
    source.runs[0].emit({ data: 'old', loading: false, error: null })
    release()
    forgetWhere((key) => key.startsWith('f2'))
    expect(source.runs[0].stopped).toBe(true)
    expect(peek('f2').loading).toBe(true)
    const again = watch('f2', source.start, () => {})
    expect(source.runs).toHaveLength(2)
    again()
  })
})

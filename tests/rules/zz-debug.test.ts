import { test } from 'vitest'
import { doc, serverTimestamp, setDoc } from 'firebase/firestore'
import { DAY, ts, useRulesEnv } from './helpers.ts'
const { db } = useRulesEnv()
const off = { stats: true, achieved: false, goals: false, earnings: false }
const tryIt = async (name: string, data: Record<string, unknown>) => {
  try { await setDoc(doc(db('alice'), 'showcases/alice'), { ...data, updatedAt: serverTimestamp() }); console.log('OK', name) } catch (e) { console.log('DENIED', name, String(e).slice(0, 300)) }
}
const a12 = Array.from({ length: 12 }, (_, i) => ({ name: `${'Ж'.repeat(57)}${String(i).padStart(3, '0')}`, at: ts(Date.now() - (i + 1) * DAY) }))
const g8 = Array.from({ length: 8 }, (_, i) => ({ name: `${'G'.repeat(59)}${i}`, pct: i * 14 }))
const e = { monthId: '2026-09', amount: 4200.5, currency: 'USD' }
test('debug', async () => {
  await tryIt('a12 cyr', { show: { ...off, achieved: true }, achieved: a12 })
  await tryIt('a12+g8', { show: { ...off, achieved: true, goals: true }, achieved: a12, goals: g8 })
  await tryIt('a12+e', { show: { ...off, achieved: true, earnings: true }, achieved: a12, earnings: e })
  await tryIt('g8+e', { show: { ...off, goals: true, earnings: true }, goals: g8, earnings: e })
  await tryIt('a6+g8+e', { show: { ...off, achieved: true, goals: true, earnings: true }, achieved: a12.slice(0, 6), goals: g8, earnings: e })
})

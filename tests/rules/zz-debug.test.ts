import { test } from 'vitest'
import { doc, serverTimestamp, setDoc } from 'firebase/firestore'
import { DAY, ts, useRulesEnv } from './helpers.ts'
const { db } = useRulesEnv()
const off = { stats: true, achieved: false, goals: false, earnings: false }
const tryIt = async (name: string, data: Record<string, unknown>) => {
  try { await setDoc(doc(db('alice'), 'showcases/alice'), { ...data, updatedAt: serverTimestamp() }); console.log('OK', name) } catch (e) { console.log('DENIED', name) }
}
test('debug', async () => {
  await tryIt('earnings', { show: { ...off, earnings: true }, earnings: { monthId: '2026-09', amount: 4200.5, currency: 'USD' } })
  await tryIt('earnings int', { show: { ...off, earnings: true }, earnings: { monthId: '2026-09', amount: 4200, currency: 'USD' } })
  await tryIt('goals 1', { show: { ...off, goals: true }, goals: [{ name: 'Car', pct: 10 }] })
  await tryIt('goals 8', { show: { ...off, goals: true }, goals: Array.from({ length: 8 }, (_, i) => ({ name: `${'G'.repeat(59)}${i}`, pct: i * 14 })) })
  await tryIt('ach 1', { show: { ...off, achieved: true }, achieved: [{ name: 'Car', at: ts(Date.now() - DAY) }] })
  await tryIt('ach 1 cyr', { show: { ...off, achieved: true }, achieved: [{ name: 'Ж'.repeat(57) + '000', at: ts(Date.now() - DAY) }] })
  await tryIt('ach 12', { show: { ...off, achieved: true }, achieved: Array.from({ length: 12 }, (_, i) => ({ name: 'Car' + i, at: ts(Date.now() - DAY) })) })
  await tryIt('ach 0', { show: { ...off, achieved: true }, achieved: [] })
})

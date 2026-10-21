// The showcase editor (SPEC §11.9.4): one switch per item anyone on Stakes can see on your profile. Each switch
// saves at once against the server's copy (setShowcaseSwitch) and shows the server's answer; money items ask
// first and wait until your money has loaded, so what they copy is complete.
import { useMemo, useState } from 'react'
import { setShowcaseSwitch, useAuth, useCurrency, useEarnings, useGoals, useMoneyState, useMoves, useShowcase } from '../../data/api.ts'
import { lastMoneyMonth, showcaseItems, showOf } from '../../domain/showcase.ts'
import type { ShowKey, ShowSwitches } from '../../domain/types.ts'
import { ActivityIndicator, Row, Screen, Section, useAlert, useNav, useToast } from '../../ui/index.ts'
import { useNow } from '../components/clock.ts'
import { monthName } from '../components/format.ts'
import { deviceZone } from '../components/zone.ts'
import { EDITOR_FOOTER, EDITOR_NOTE, showConfirm, switchCopy } from './copy.ts'
import { errorText } from './parts.tsx'
import { ShowcaseScreen } from './ShowcaseScreen.tsx'

const KEYS: ShowKey[] = ['stats', 'achieved', 'goals', 'earnings']

export function ShowcaseEditorScreen() {
  const nav = useNav()
  const toast = useToast()
  const { confirm } = useAlert()
  const auth = useAuth()
  const me = auth.uid ?? ''
  const nowMs = useNow()
  const showcase = useShowcase(me)
  const state = useMoneyState()
  const earnings = useEarnings()
  const moves = useMoves()
  const goals = useGoals()
  const currency = useCurrency()
  const [pending, setPending] = useState<Partial<ShowSwitches>>({})

  const moneyLoaded = state.data !== undefined && earnings.data !== undefined && moves.data !== undefined && goals.data !== undefined
  const zone = deviceZone()
  const month = monthName(lastMoneyMonth(nowMs, zone))
  const items = useMemo(
    () =>
      moneyLoaded
        ? showcaseItems({ moves: moves.data ?? [], goals: goals.data ?? [], earnings: earnings.data ?? [], state: state.data ?? null, currency }, nowMs, zone)
        : null,
    [moneyLoaded, moves.data, goals.data, earnings.data, state.data, currency, nowMs, zone],
  )
  const stored = showcase.data === undefined ? null : showOf(showcase.data)

  const toggle = async (key: ShowKey, on: boolean) => {
    if (!items || key in pending) return
    const ask = on ? showConfirm(key, month) : null
    if (ask && !(await confirm({ title: ask.title, message: ask.message, confirmLabel: ask.confirmLabel, cancelLabel: ask.cancelLabel }))) return
    setPending((p) => ({ ...p, [key]: on }))
    try {
      await setShowcaseSwitch(key, on, items)
    } catch (e) {
      toast({ title: 'Couldn’t update your showcase', message: errorText(e), tone: 'error' })
    } finally {
      setPending((p) => {
        const next = { ...p }
        delete next[key]
        return next
      })
    }
  }

  return (
    <Screen title="Showcase" titleDisplay="inline">
      <p className="fr-editor-note">{EDITOR_NOTE}</p>
      <Section header="Show" footer={EDITOR_FOOTER}>
        {KEYS.map((key) => {
          const copy = switchCopy(key, month)
          const saving = key in pending
          const value = saving ? pending[key] === true : stored ? stored[key] : false
          return (
            <Row
              key={key}
              title={copy.title}
              subtitle={copy.subtitle}
              toggle={value}
              onToggle={(on) => void toggle(key, on)}
              disabled={!stored || !items}
              accessory={saving ? <ActivityIndicator color="var(--secondary-label)" label="Saving" /> : undefined}
            />
          )
        })}
      </Section>
      <Section>
        <Row
          title="See Your Showcase"
          chevron
          onPress={() => nav.push(<ShowcaseScreen uid={me} name={auth.profile?.name} onEdit={() => nav.pop()} />, { title: auth.profile?.name })}
        />
      </Section>
    </Screen>
  )
}

// The showcase editor (SPEC §11.9.4): one switch per item anyone on Stakes can see on your profile. Each switch
// saves at once against the server's copy (setShowcaseSwitch) and shows the server's answer; money items ask
// first and wait until your money has loaded, so what they copy is complete.
import { useEffect, useMemo, useState } from 'react'
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
  // A switch being saved, or saved and not yet back from the server's copy: it shows its new state meanwhile, so
  // it never flicks back for a moment between the write and the listener catching up.
  const [pending, setPending] = useState<Partial<Record<ShowKey, { on: boolean; saving: boolean }>>>({})

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
  const stored: ShowSwitches | null = showcase.data === undefined ? null : showOf(showcase.data)

  const drop = (key: ShowKey) =>
    setPending((p) => {
      const next = { ...p }
      delete next[key]
      return next
    })

  // A saved switch hands over to the stored one once the listener has it.
  useEffect(() => {
    if (!stored) return
    for (const key of KEYS) {
      const p = pending[key]
      if (p && !p.saving && stored[key] === p.on) drop(key)
    }
  }, [stored, pending])

  const toggle = async (key: ShowKey, on: boolean) => {
    if (!items || pending[key]) return
    const ask = on ? showConfirm(key, month) : null
    if (ask && !(await confirm({ title: ask.title, message: ask.message, confirmLabel: ask.confirmLabel, cancelLabel: ask.cancelLabel }))) return
    setPending((p) => ({ ...p, [key]: { on, saving: true } }))
    try {
      await setShowcaseSwitch(key, on, items)
      setPending((p) => ({ ...p, [key]: { on, saving: false } }))
      // Should another device change it meanwhile, the stored switch wins anyway.
      window.setTimeout(() => {
        setPending((p) => {
          if (p[key]?.saving !== false) return p
          const next = { ...p }
          delete next[key]
          return next
        })
      }, 4000)
    } catch (e) {
      drop(key)
      toast({ title: 'Couldn’t update your showcase', message: errorText(e), tone: 'error' })
    }
  }

  return (
    <Screen title="Showcase" titleDisplay="inline">
      <p className="fr-editor-note">{EDITOR_NOTE}</p>
      <Section header="Show" footer={EDITOR_FOOTER}>
        {KEYS.map((key) => {
          const copy = switchCopy(key, month)
          const p = pending[key]
          const saving = p?.saving === true
          const value = p ? p.on : stored ? stored[key] : false
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

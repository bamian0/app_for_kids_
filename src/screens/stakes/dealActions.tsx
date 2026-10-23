// What people do with deals, with their confirms and toasts (SPEC §12.10), shared by the stakes card, the Stakes
// screen and a deal's own screen: make one (the editor), Same Again, Agree, Withdraw, Call Off and Settled.
import { agreeToDeal, callOffDeal, proposeDeal, settleDeal, withdrawDeal } from '../../data/api.ts'
import { now as appNow } from '../../domain/clock.ts'
import { dealFriends, sameAgain as sameAgainInput } from '../../domain/deals.ts'
import type { DealState } from '../../domain/deals.ts'
import type { Deal, DealInput, Space } from '../../domain/types.ts'
import { haptic, useAlert, useSheet, useToast } from '../../ui/index.ts'
import { DealEditorSheet } from './DealEditorSheet.tsx'
import { agreeDealConfirm, callOffConfirm, clockOf, proposedToast, sameAgainConfirm, WITHDRAW_CONFIRM } from './deals.ts'
import type { Name, SettleRow } from './deals.ts'

const failed = (e: unknown) => (e instanceof Error ? e.message : undefined)

/** A confirm's lines, each on its own line with a little air before the last ("It starts next week."). */
function Lines({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <span key={i} style={{ display: 'block', marginTop: i > 0 && i === lines.length - 1 ? 8 : 0 }}>
          {line}
        </span>
      ))}
    </>
  )
}

export interface DealActions {
  /** The editor: a new deal (from the house stakes), Same Again's input with texts missing, or Edit (replace). */
  edit: (opts?: { input?: DealInput; missing?: string[]; replace?: Deal; onProposed?: () => void }) => void
  /** Same Again: proposes at once after a confirm, or opens the editor when a newcomer has no text yet. */
  sameAgain: (last: Deal) => Promise<void>
  agree: (deal: Deal, state: DealState) => Promise<void>
  withdraw: (deal: Deal) => Promise<boolean>
  callOff: (deal: Deal, state: DealState) => Promise<void>
  settle: (row: SettleRow) => void
}

export function useDealActions(space: Space, me: string, name: Name): DealActions {
  const sheet = useSheet()
  const toast = useToast()
  const { confirm } = useAlert()

  const edit: DealActions['edit'] = (opts = {}) => {
    sheet.present((close) => <DealEditorSheet space={space} input={opts.input} missing={opts.missing} replace={opts.replace} close={close} onProposed={opts.onProposed} name={name} />, { 'aria-label': opts.replace ? 'Edit Deal' : 'New Deal' })
  }

  const sameAgain = async (last: Deal) => {
    const friends = dealFriends(space, me)
    const { input, missing } = sameAgainInput(last, friends)
    if (missing.length > 0) {
      edit({ input, missing })
      return
    }
    const ask = sameAgainConfirm(last, space.threshold)
    const ok = await confirm({ title: ask.title, message: ask.message, confirmLabel: 'Propose' })
    if (!ok) return
    try {
      await proposeDeal(space, input)
      haptic()
      const done = proposedToast(friends, name, false)
      toast({ title: done.title, message: done.message, icon: 'handshake', tone: 'success' })
    } catch (e) {
      toast({ title: 'Couldn’t propose the deal', message: failed(e), tone: 'error' })
    }
  }

  const agree = async (deal: Deal, state: DealState) => {
    const nowMs = appNow()
    const ask = agreeDealConfirm(deal, state, me, name, space.threshold, nowMs, space.timezone, clockOf(space, deal.unit))
    const ok = await confirm({ title: ask.title, message: <Lines lines={ask.lines} />, confirmLabel: 'Agree' })
    if (!ok) return
    try {
      await agreeToDeal(space, deal.id)
      haptic()
      toast({ title: ask.toast.title, message: ask.toast.message, icon: 'checkmark', tone: 'success' })
    } catch (e) {
      toast({ title: 'Couldn’t agree', message: failed(e), tone: 'error' })
    }
  }

  const withdraw = async (deal: Deal) => {
    const ok = await confirm({ ...WITHDRAW_CONFIRM, destructive: true })
    if (!ok) return false
    try {
      await withdrawDeal(space, deal.id)
      toast({ title: 'Deal withdrawn' })
      return true
    } catch (e) {
      toast({ title: 'Couldn’t withdraw it', message: failed(e), tone: 'error' })
      return false
    }
  }

  const callOff = async (deal: Deal, state: DealState) => {
    const ask = callOffConfirm(deal, state, me, name)
    const ok = await confirm({ title: ask.title, message: ask.message, confirmLabel: 'Call Off', cancelLabel: 'Keep Going', destructive: true })
    if (!ok) return
    try {
      await callOffDeal(space, deal.id)
      toast({ title: ask.toast.title, message: ask.toast.message })
    } catch (e) {
      toast({ title: 'Couldn’t call it off', message: failed(e), tone: 'error' })
    }
  }

  const settle = (row: SettleRow) => {
    settleDeal(space, row.deal.id, row.line.keys, !row.settled).catch((e: unknown) => toast({ title: 'Couldn’t update', message: failed(e), tone: 'error' }))
  }

  return { edit, sameAgain, agree, withdraw, callOff, settle }
}

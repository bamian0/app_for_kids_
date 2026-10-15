// The pause card at the top of the Space screen (SPEC §9.3): a request waiting for OKs (answer it, wait, or
// cancel your own), a Not Now, a week that is paused, or, for the asker, a pause that didn't happen.
import { useState } from 'react'
import { answerPause, withdrawPause } from '../../data/api.ts'
import type { Space } from '../../domain/types.ts'
import { Avatar, Button, Icon, Section, cx, haptic, useAlert, useToast } from '../../ui/index.ts'
import { personOf } from '../components/people.ts'
import type { Profiles } from '../components/people.ts'
import type { PauseCardView } from './space.ts'
import './space.css'

export interface PauseCardProps {
  space: Space
  view: PauseCardView
  profiles: Profiles
  /** The asker's name, for the Not Now confirm ("Lena can ask again later."). */
  askerName: string
  onDismiss: (seenKey: string) => void
}

const failed = (e: unknown) => (e instanceof Error ? e.message : undefined)

export function PauseCard({ space, view, profiles, askerName, onDismiss }: PauseCardProps) {
  const toast = useToast()
  const { confirm } = useAlert()
  const [busy, setBusy] = useState<'ok' | 'not-now' | 'cancel' | null>(null)

  const run = async (kind: 'ok' | 'not-now' | 'cancel', action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(kind)
    try {
      await action()
    } catch (e) {
      toast({ title: 'Couldn’t do that', message: failed(e), tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const ok = () => {
    haptic()
    void run('ok', () => answerPause(space, 'ok'))
  }
  const notNow = async () => {
    const sure = await confirm({
      title: 'Say not now?',
      message: `The week goes on as usual. ${askerName} can ask again later.`,
      confirmLabel: 'Not Now',
      destructive: true,
    })
    if (sure) void run('not-now', () => answerPause(space, 'not-now'))
  }
  const cancel = async () => {
    const sure = await confirm({ title: 'Cancel the request?', confirmLabel: 'Cancel Request', cancelLabel: 'Keep It', destructive: true })
    if (sure) void run('cancel', () => withdrawPause(space))
  }

  const dismissable = view.seenKey !== undefined
  const head = (
    <>
      <span className="sp-tile" aria-hidden>
        <Icon name="pause" size={18} weight={2.4} />
      </span>
      <span className="sp-line__text">
        <span className="sp-line__title">{view.title}</span>
        <span className="sp-line__subtitle">{view.subtitle}</span>
      </span>
    </>
  )

  if (dismissable) {
    return (
      <Section className="sp-pause">
        <div className="sp-line">
          <div className="sp-line__main sp-line__main--static">{head}</div>
          <button type="button" className="sp-close" aria-label="Dismiss" onClick={() => onDismiss(view.seenKey as string)}>
            <span className="sp-close__dot">
              <Icon name="xmark" size={11} weight={3} />
            </span>
          </button>
        </div>
      </Section>
    )
  }

  return (
    <Section className="sp-pause">
      <div className="sp-block">
        <div className="sp-head">{head}</div>
        {view.people && view.people.length > 0 && (
          <div className="sp-people">
            <span className="sp-people__stack">
              {view.people.map(({ uid, ok: said }) => {
                const person = personOf(profiles, uid)
                return (
                  <span key={uid} className={cx('sp-person', !said && 'sp-person--waiting')}>
                    <Avatar name={person.name} color={person.color} photo={person.photo} size={28} />
                    {said && (
                      <span className="sp-person__check" aria-hidden>
                        <Icon name="checkmark" size={9} weight={3.4} />
                      </span>
                    )}
                  </span>
                )
              })}
            </span>
            {view.count && <span className="sp-people__count t-tabular">{view.count}</span>}
          </div>
        )}
        {view.role === 'to-answer' && (
          <div className="sp-actions">
            <Button fullWidth loading={busy === 'ok'} disabled={busy !== null && busy !== 'ok'} onClick={ok}>
              OK
            </Button>
            <Button fullWidth variant="gray" loading={busy === 'not-now'} disabled={busy !== null && busy !== 'not-now'} onClick={() => void notNow()}>
              Not Now
            </Button>
          </div>
        )}
        {view.status && <div className="sp-status">{view.status}</div>}
        {view.role === 'asked' && (
          <div className="sp-actions sp-actions--single">
            <Button size="small" variant="gray" loading={busy === 'cancel'} onClick={() => void cancel()}>
              Cancel Request
            </Button>
          </div>
        )}
      </div>
    </Section>
  )
}

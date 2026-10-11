// First launch: what Stakes is, in three lines, and the way in. An invite link shows who invited
// you, to what, and for which stakes. The two actions stay pinned above the home indicator.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { lookupInvite } from '../../data/api.ts'
import { formatInviteCode } from '../../domain/ids.ts'
import type { Invite } from '../../domain/types.ts'
import { isStandalone } from '../../push/index.ts'
import { Avatar, Button, Icon, ScoreRing, Screen, Section, useNav } from '../../ui/index.ts'
import type { IconName } from '../../ui/index.ts'
import { peekPendingJoin } from '../components/pendingJoin.ts'
import { StakesList } from '../components/Stakes.tsx'
import { SignInScreen, SignUpScreen } from './AuthScreens.tsx'

function Feature({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <li className="s-feature">
      <span className="s-feature__icon" aria-hidden>
        <Icon name={icon} size={26} weight={1.9} />
      </span>
      <span className="s-feature__text">
        <span className="s-feature__title">{title}</span>
        <span className="s-feature__body">{children}</span>
      </span>
    </li>
  )
}

/** Short phones (iPhone SE: 667pt, 647 under the status bar in the installed app). */
function useShortScreen(limit = 740): boolean {
  const [short, setShort] = useState(() => typeof window !== 'undefined' && window.innerHeight < limit)
  useEffect(() => {
    const update = () => setShort(window.innerHeight < limit)
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [limit])
  return short
}

/** The invite behind a ?join= link, looked up signed out (the code is the secret). */
function usePendingInvite(code: string | null): Invite | null {
  const [invite, setInvite] = useState<Invite | null>(null)
  useEffect(() => {
    if (!code) return
    let live = true
    lookupInvite(code).then(
      (found) => live && setInvite(found),
      () => {},
    )
    return () => {
      live = false
    }
  }, [code])
  return invite
}

export function WelcomeScreen() {
  const nav = useNav()
  const code = peekPendingJoin()
  const invite = usePendingInvite(code)
  // The installed app is where friends who signed up in Safari land: signing in comes first there.
  const installed = isStandalone()
  // Short phones get a smaller hero so the features fit above the pinned actions.
  const compact = useShortScreen()

  const signUp = () => nav.push(<SignUpScreen />, { title: 'Create Account' })
  const signIn = () => nav.push(<SignInScreen />, { title: 'Sign In' })
  const create = (
    <Button key="create" size="large" fullWidth variant={installed ? 'plain' : 'filled'} onClick={signUp}>
      Create Account
    </Button>
  )
  const existing = (
    <Button key="existing" size="large" fullWidth variant={installed ? 'filled' : 'plain'} onClick={signIn}>
      {installed ? 'Sign In' : 'I Have an Account'}
    </Button>
  )

  return (
    <Screen
      title="Stakes"
      subtitle="Put something on the line."
      className={compact ? 's-welcome s-welcome--compact' : 's-welcome'}
      toolbar={
        <div className="s-welcome__actions">
          {installed ? (
            <p className="s-welcome__note">Signed up in Safari? Same email, same password.</p>
          ) : (
            code && !invite && <p className="s-welcome__note">You’ve been invited. Sign up or sign in to join.</p>
          )}
          {installed ? [existing, create] : [create, existing]}
        </div>
      }
      toolbarFullWidth
    >
      {invite ? (
        <>
          <Section padded>
            <div className="s-join-preview">
              <Avatar name={invite.spaceName} color="var(--system-gray)" size={56} />
              <div className="s-join-preview__title">
                {invite.inviterName} invited you to {invite.spaceName}
              </div>
              <div className="s-join-preview__text">Every week you plan, every Friday friends grade you, every month someone pays.</div>
            </div>
          </Section>
          {invite.reward && invite.penalty && (
            <Section header="What’s at stake">
              <StakesList reward={invite.reward} penalty={invite.penalty} />
            </Section>
          )}
          <Section padded footer="Installing the app first? Type this code in Join with Code. It isn’t case-sensitive.">
            <div className="s-invite">
              <div className="s-invite__label">Invite code</div>
              <div className="s-invite__code" aria-label={`Invite code ${invite.code.split('').join(' ')}`}>
                {formatInviteCode(invite.code)}
              </div>
            </div>
          </Section>
        </>
      ) : (
        <div className="s-welcome__body">
          <div className="s-welcome__hero">
            {/* Graphite: the prism is kept for real moments (a reveal, a verdict, a real 90%). */}
            <ScoreRing value={94} iridescent={false} size={compact ? 96 : 132} stroke={compact ? 11 : 14} delay={0.35} aria-label="94 percent, above the bar" />
          </div>
          <ul className="s-features">
            <Feature icon="listBullet" title="Plan your week">
              Every task is a promise. Your list locks Monday at midnight.
            </Feature>
            <Feature icon="person2" title="Friends grade you">
              Every Friday, blind. Done, half, or not done.
            </Feature>
            <Feature icon="trophy" title="Hit 90% and they owe you">
              Miss it and you pay up. Settled monthly.
            </Feature>
          </ul>
        </div>
      )}
    </Screen>
  )
}

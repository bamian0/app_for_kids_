// First launch: what Stakes is, in three lines, and the way in.
import type { ReactNode } from 'react'
import { Button, Icon, ScoreRing, Screen, requestMotionPermission, useNav } from '../../ui/index.ts'
import type { IconName } from '../../ui/index.ts'
import { hasPendingJoin } from '../components/pendingJoin.ts'
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

export function WelcomeScreen() {
  const nav = useNav()
  const invited = hasPendingJoin()

  const go = (screen: ReactNode, title: string) => {
    // Tilt-driven glass highlights need a tap to ask for motion access on iPhone.
    void requestMotionPermission()
    nav.push(screen, { title })
  }

  return (
    <Screen title="Stakes" subtitle="Put something on the line." className="s-welcome">
      <div className="s-welcome__body">
        <div className="s-welcome__hero">
          <ScoreRing value={94} size={132} stroke={14} delay={0.35} aria-label="94 percent, above the bar" />
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
        <div className="s-welcome__actions">
          {invited && <p className="s-welcome__invite">You’ve been invited. Sign up or sign in to join.</p>}
          <Button size="large" fullWidth onClick={() => go(<SignUpScreen />, 'Create Account')}>
            Create Account
          </Button>
          <Button size="large" fullWidth variant="plain" onClick={() => go(<SignInScreen />, 'Sign In')}>
            I Have an Account
          </Button>
        </div>
      </div>
    </Screen>
  )
}

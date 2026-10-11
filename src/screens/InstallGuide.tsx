// How to put Stakes on the iPhone Home Screen, and why it matters (reminders, separate sign-in).
// The steps cover both iOS 26 Safari layouts: Compact (Share sits in the ••• menu) and Bottom/Top
// (a Share button in the bar).
import type { ReactNode } from 'react'
import { GlassButton, Icon, Row, Screen, Section } from '../ui/index.ts'

function Step({ n, children }: { n: number; children: ReactNode }) {
  return <Row leading={<span className="s-step">{n}</span>} title={children} />
}

export function InstallGuideSheet({ close, joined }: { close: () => void; /** Name of a space just joined. */ joined?: string }) {
  return (
    <Screen title="Add to Home Screen" titleDisplay="inline" trailing={<GlassButton prominent icon="checkmark" aria-label="Done" onClick={close} />}>
      <div className="s-sheet-hero">
        <img className="s-app-icon" src="./icons/apple-touch-icon.png" alt="" width={72} height={72} />
        <div className="s-sheet-hero__title">{joined ? `You’re in ${joined}.` : 'Install Stakes'}</div>
        <div className="s-sheet-hero__text">
          {joined
            ? 'Now put Stakes on your Home Screen: reminders before every deadline only reach the installed app.'
            : 'It opens full screen like any other app, and it can remind you before deadlines.'}
        </div>
      </div>
      <Section header="In Safari">
        <Step n={1}>
          Tap <Icon name="ellipsis" size={19} className="s-inline-icon" title="More" /> in Safari’s bar (or <Icon name="share" size={19} className="s-inline-icon" title="Share" />), then{' '}
          <strong>Share</strong>
        </Step>
        <Step n={2}>
          Tap <Icon name="addToHomeScreen" size={19} className="s-inline-icon" /> <strong>Add to Home Screen</strong>. Not listed? Tap <strong>More</strong>.
        </Step>
        <Step n={3}>
          Keep <strong>Open as Web App</strong> on, then tap <strong>Add</strong>
        </Step>
        <Step n={4}>
          Open Stakes from your Home Screen, sign in, and tap <strong>Turn On</strong> for reminders
        </Step>
      </Section>
      <Section header="Good to know">
        <Row icon="bell" title="Reminders need the installed app" subtitle="iPhone only lets Home Screen apps send notifications. A missed review costs 5 points." />
        <Row icon="person" title="Sign in once more" subtitle="The installed app keeps its own storage, separate from Safari. Same email, same password, same spaces." />
        <Row icon="link" title="Invites: type the code" subtitle="Invite links open in Safari. In the app, use Join with Code." />
      </Section>
    </Screen>
  )
}

// How to put Stakes on the iPhone Home Screen, and why it matters (reminders, separate sign-in).
import type { ReactNode } from 'react'
import { GlassButton, Icon, Row, Screen, Section } from '../ui/index.ts'

function Step({ n, children }: { n: number; children: ReactNode }) {
  return <Row leading={<span className="s-step">{n}</span>} title={children} />
}

export function InstallGuideSheet({ close }: { close: () => void }) {
  return (
    <Screen
      title="Add to Home Screen"
      titleDisplay="inline"
      trailing={
        <GlassButton prominent onClick={close}>
          Done
        </GlassButton>
      }
    >
      <div className="s-sheet-hero">
        <img className="s-app-icon" src="./icons/apple-touch-icon.png" alt="" width={72} height={72} />
        <div className="s-sheet-hero__title">Install Stakes</div>
        <div className="s-sheet-hero__text">It opens full screen like any other app, and it can remind you before deadlines.</div>
      </div>
      <Section header="In Safari">
        <Step n={1}>
          Tap <Icon name="share" size={19} className="s-inline-icon" /> <strong>Share</strong> in the toolbar
        </Step>
        <Step n={2}>
          Scroll down, tap <Icon name="addToHomeScreen" size={19} className="s-inline-icon" /> <strong>Add to Home Screen</strong>
        </Step>
        <Step n={3}>
          Tap <strong>Add</strong>, then open Stakes from your Home Screen
        </Step>
      </Section>
      <Section header="Good to know">
        <Row icon="bell" title="Reminders need the installed app" subtitle="iPhone only lets Home Screen apps send notifications." />
        <Row icon="person" title="Sign in once more" subtitle="The installed app keeps its own storage, separate from Safari. Same account, same spaces." />
        <Row icon="link" title="Invites: type the code" subtitle="Invite links open in Safari. In the app, use Join with Code." />
      </Section>
    </Screen>
  )
}

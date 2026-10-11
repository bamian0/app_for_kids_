// "How Stakes works": the rules from the spec, short enough to read in a minute.
import type { ReactNode } from 'react'
import { Icon, Screen, Section } from '../ui/index.ts'
import type { IconName } from '../ui/index.ts'

function Rule({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <div className="s-rule">
      <span className="s-rule__icon" aria-hidden>
        <Icon name={icon} size={22} weight={1.9} />
      </span>
      <div className="s-rule__text">
        <div className="s-rule__title">{title}</div>
        <div className="s-rule__body">{children}</div>
      </div>
    </div>
  )
}

export function RulesScreen({ timezone }: { timezone?: string }) {
  return (
    <Screen title="How Stakes Works" titleDisplay="inline">
      <Section footer={timezone ? `Every deadline in this space runs on ${timezone} time.` : 'Every deadline runs on the time zone of the space’s creator.'}>
        <Rule icon="listBullet" title="Plan">
          List what you’ll get done this week. Your list locks Monday at midnight. Plan next week any time.
        </Rule>
        <Rule icon="checkmark" title="Do">
          Tick tasks off as you finish them. Everyone in the space can see your check-offs.
        </Rule>
        <Rule icon="person2" title="Review">
          On Friday, mark every friend’s tasks: Done, Half, or Not done. Reviews are blind, final, and due Friday at midnight.
        </Rule>
        <Rule icon="sparkles" title="Score">
          Your week is the average of your friends’ marks. Nothing planned is 0%. If nobody reviews you, your own check-offs count.
        </Rule>
        <Rule icon="clock" title="Late">
          Every friend you don’t review costs you 5 points off your month.
        </Rule>
        <Rule icon="trophy" title="Pay up">
          Your month is the average of your weeks, minus late points. A week counts in the month its Friday falls in. Hit 90% and the others owe you the reward. Miss and you owe them the penalty. Settle it in real life, then mark it settled.
        </Rule>
      </Section>
    </Screen>
  )
}

// Dev-only component gallery (gallery.html). Doubles as a living reference for screen code.
import { useState } from 'react'
import type { ReviewMark } from '../domain/types.ts'
import {
  ActivityIndicator,
  Avatar,
  AvatarStack,
  Badge,
  Button,
  CheckCircle,
  EmptyState,
  GlassButton,
  GlassSurface,
  Icon,
  iconNames,
  MarkPicker,
  NavigationStack,
  Pill,
  ProgressBar,
  Row,
  Screen,
  ScoreRing,
  Section,
  SecureField,
  SegmentedControl,
  Sheet,
  Shimmer,
  Text,
  TextArea,
  TextFieldRow,
  Toggle,
  UIProvider,
  useAlert,
  useEdgeGlow,
  useNav,
  useSheet,
  useToast,
} from './index.ts'
import './gallery.css'

const PEOPLE = [
  { id: 'a', name: 'Marco Rossi', color: '#6B7F9E' },
  { id: 'b', name: 'Lena Fischer', color: '#A57583' },
  { id: 'c', name: 'Sam Okafor', color: '#74876F' },
  { id: 'd', name: 'Yuki Tanaka', color: '#8C7699' },
  { id: 'e', name: 'Ines Duarte', color: '#A5735F' },
  { id: 'f', name: 'Theo Martin', color: '#5D8889' },
]

const RING_STATES: Array<{ label: string; value: number | null; iridescent?: boolean }> = [
  { label: 'None', value: null },
  { label: '40', value: 40 },
  { label: '89.9', value: 89.9 },
  { label: '90', value: 90 },
  { label: '97', value: 97 },
  { label: '100', value: 100 },
  { label: '100 prov.', value: 100, iridescent: false },
]

const TASKS = [
  { id: 't1', title: 'Color grade the Nike spot, first pass' },
  { id: 't2', title: 'Send the treatment for the music video to Lena' },
  { id: 't3', title: 'Test the new anamorphic lenses on a night exterior and log the flare characteristics' },
  { id: 't4', title: 'Update the reel' },
]

export function Gallery() {
  return (
    <UIProvider>
      <NavigationStack root={<Home />} />
    </UIProvider>
  )
}

function Home() {
  const nav = useNav()
  const sheet = useSheet()
  const { alert, confirm, actionSheet } = useAlert()
  const toast = useToast()
  const glow = useEdgeGlow()
  const [ring, setRing] = useState<'60' | '90' | '95'>('95')
  const [done, setDone] = useState<Record<string, boolean>>({ t2: true })
  const [shimmerKey, setShimmerKey] = useState<string | undefined>()
  const [marks, setMarks] = useState<Record<string, ReviewMark | null>>({ t1: 1, t2: 0.5, t3: null, t4: 0 })
  const [reminders, setReminders] = useState(true)
  const [friday, setFriday] = useState(false)
  const [name, setName] = useState('Marco')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('secret123')
  const [stakes, setStakes] = useState('Dinner at Da Enzo, loser pays')
  const [view, setView] = useState<'week' | 'next' | 'month'>('week')
  const [loading, setLoading] = useState(false)
  const [declarativeSheet, setDeclarativeSheet] = useState(false)

  const doneCount = TASKS.filter((t) => done[t.id]).length

  return (
    <Screen
      title="Stakes"
      subtitle="Design system gallery"
      trailing={
        <>
          <GlassButton icon="bell" aria-label="Reminders" onClick={() => toast({ title: 'Reviews open tomorrow', message: 'Friday 00:00 · 3 friends to review', icon: 'bell' })} />
          <GlassButton icon="plus" aria-label="New space" onClick={() => setDeclarativeSheet(true)} />
        </>
      }
      toolbar={
        <Button size="large" fullWidth icon="checkmark" onClick={() => nav.push(<ReviewScreen />, { title: 'Review' })}>
          Review Friends
        </Button>
      }
      toolbarFullWidth
    >
      <Section padded>
        <div className="g-hero">
          <ScoreRing value={Number(ring)} size={132} stroke={14} showValue />
          <div className="g-hero__text">
            <Text variant="footnote" color="secondary" weight="semibold">
              OCTOBER SO FAR
            </Text>
            <Text variant="title2" as="div">
              {Number(ring) >= 90 ? 'They owe you dinner' : 'You owe the coffee'}
            </Text>
            <Text variant="subheadline" color="secondary" as="div">
              Bar is 90%. 3 weeks scored, 1 to go.
            </Text>
          </div>
        </div>
        <div className="g-gap" />
        <SegmentedControl
          aria-label="Ring value"
          options={[
            { value: '60', label: '60%' },
            { value: '90', label: '90%' },
            { value: '95', label: '95%' },
          ]}
          value={ring}
          onChange={setRing}
        />
      </Section>

      <Section
        header="Score rings"
        footer="No score, below the bar (gap marks 90%), at the bar, nearly full (the end cap shades the start), full, and a provisional 100% kept graphite with iridescent={false}."
      >
        <div className="g-pad g-rings">
          {RING_STATES.map((r) => (
            <div key={r.label} className="g-ring">
              <ScoreRing value={r.value} iridescent={r.iridescent} size={64} stroke={7} />
              <Text variant="caption2" color="secondary" as="div">
                {r.label}
              </Text>
            </div>
          ))}
        </div>
      </Section>

      <Section
        header="This week"
        headerStyle="prominent"
        headerAccessory={<Pill icon="clock">Locks in 5h 12m</Pill>}
        footer={`${doneCount} of ${TASKS.length} done. Check off tasks as you finish them; friends review on Friday.`}
      >
        {TASKS.map((t) => (
          <Shimmer key={t.id} trigger={shimmerKey === t.id ? t.id : undefined}>
            <Row
              title={<span className={done[t.id] ? 'g-done' : undefined}>{t.title}</span>}
              leading={
                <CheckCircle
                  checked={!!done[t.id]}
                  aria-label={t.title}
                  onChange={(v) => {
                    setDone((d) => ({ ...d, [t.id]: v }))
                    if (v) setShimmerKey(t.id)
                  }}
                />
              }
            />
          </Shimmer>
        ))}
        <Row title="Add Task" action leading={<Icon name="plus" size={22} weight={2.2} />} onPress={() => toast('Add task tapped')} />
      </Section>

      <Section header="Friday review" footer="Blind until everyone submits or the deadline passes.">
        {TASKS.slice(0, 3).map((t) => (
          <div key={t.id} className="g-review-row">
            <Text variant="body" as="div">
              {t.title}
            </Text>
            <MarkPicker value={marks[t.id] ?? null} onChange={(m) => setMarks((x) => ({ ...x, [t.id]: m }))} aria-label={`Mark for ${t.title}`} />
          </div>
        ))}
        <Row
          title="Update the reel"
          accessory={<MarkPicker size="compact" value={marks.t4 ?? null} onChange={(m) => setMarks((x) => ({ ...x, t4: m }))} />}
        />
        <div className="g-review-row">
          <Text variant="body" as="div">
            Swim 3 times (crossed out)
          </Text>
          <MarkPicker choices="vote" value={marks.t5 ?? null} onChange={(m) => setMarks((x) => ({ ...x, t5: m }))} aria-label="Vote for Swim 3 times" />
        </div>
      </Section>

      <Section header="Friends" headerAccessory={<AvatarStack people={PEOPLE} max={4} size={26} />}>
        {PEOPLE.slice(0, 3).map((p, i) => (
          <Row
            key={p.id}
            leading={<Avatar name={p.name} color={p.color} size={38} />}
            title={p.name}
            subtitle={i === 0 ? '4 of 5 tasks · reviewed' : i === 1 ? 'Waiting for review' : '2 tasks planned'}
            detail={['96%', '—', '71%'][i]}
            chevron
            onPress={() => nav.push(<PersonScreen name={p.name} color={p.color} />)}
          />
        ))}
      </Section>

      <Section header="Buttons">
        <div className="g-buttons">
          <div className="g-row">
            <Button>Filled</Button>
            <Button variant="gray">Gray</Button>
            <Button variant="plain">Plain</Button>
            <Button variant="gray" icon="ellipsis" aria-label="More" />
          </div>
          <div className="g-row">
            <Button variant="destructive" icon="trash">
              Delete
            </Button>
            <Button variant="gray" size="small" icon="share">
              Share
            </Button>
            <Button size="small">Small</Button>
          </div>
          <Button
            size="large"
            fullWidth
            loading={loading}
            onClick={() => {
              setLoading(true)
              window.setTimeout(() => setLoading(false), 1600)
            }}
          >
            Create Space
          </Button>
          <Button size="large" fullWidth variant="gray" disabled>
            Disabled
          </Button>
        </div>
      </Section>

      <Section header="Controls">
        <div className="g-pad">
          <SegmentedControl
            aria-label="Week"
            options={[
              { value: 'week', label: 'This Week' },
              { value: 'next', label: 'Next Week' },
              { value: 'month', label: 'Month' },
            ]}
            value={view}
            onChange={setView}
          />
        </div>
        <Row icon="bell" title="Reminders" toggle={reminders} onToggle={setReminders} />
        <Row icon="calendar" iconBackground="#636366" title="Friday digest" toggle={friday} onToggle={setFriday} />
        <Row icon="lock" title="Locked rows look like this" subtitle="Tasks lock Monday at midnight" disabled />
      </Section>

      <Section header="Form" footer="Fields use 17px text so iOS never zooms on focus.">
        <TextFieldRow label="Name" value={name} onChange={setName} placeholder="Your name" autoComplete="name" />
        <TextFieldRow label="Email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" autoComplete="email" inputMode="email" />
        <div className="ui-row ui-row--field">
          <span className="ui-row__main">
            <span className="ui-row__field-label" style={{ width: 96 }}>
              Password
            </span>
            <SecureField value={password} onChange={setPassword} placeholder="Required" />
          </span>
        </div>
      </Section>
      <Section header="Stakes">
        <TextArea value={stakes} onChange={setStakes} placeholder="What does the loser owe?" minRows={2} maxRows={6} />
      </Section>

      <Section header="Status">
        <div className="g-pad g-wrap">
          <Pill icon="clock">Locks in 5h 12m</Pill>
          <Pill tone="filled" icon="flame">3-week streak</Pill>
          <Pill tone="green" icon="checkmark">On track</Pill>
          <Pill tone="red" icon="clock">-5 late</Pill>
          <Pill tone="iridescent" icon="sparkles">94% · Winner</Pill>
          <Pill size="small">Provisional</Pill>
          <Badge count={3} />
          <Badge count={12} tone="red" />
          <ActivityIndicator />
          <ActivityIndicator size="large" />
        </div>
        <div className="g-pad g-progress">
          <ProgressBar value={0.4} label="Week progress" />
          <ProgressBar value={0.92} tone="iridescent" label="Month" />
        </div>
      </Section>

      <Section header="Navigation & overlays">
        <Row icon="arrowUpRight" title="Push a screen" chevron onPress={() => nav.push(<DetailScreen depth={1} />, { title: 'Detail' })} />
        <Row
          icon="listBullet"
          title="Sheet (medium + large)"
          chevron
          onPress={() => sheet.present((close) => <SheetDemo close={close} />, { detents: ['medium', 'large'] })}
        />
        <Row icon="addToHomeScreen" title="Full-screen flow" chevron onPress={() => sheet.present((close) => <FlowDemo close={close} />, { presentation: 'fullScreen' })} />
        <Row icon="info" title="Alert" onPress={() => alert({ title: 'Reviews are final', message: 'Once you submit, you can’t change your marks.' })} />
        <Row
          icon="trash"
          iconBackground="var(--system-red)"
          title="Confirm (destructive)"
          onPress={async () => {
            const ok = await confirm({ title: 'Leave “Film Crew”?', message: 'Your scores stay, but you won’t be part of next week.', confirmLabel: 'Leave', destructive: true })
            if (ok) toast({ title: 'You left Film Crew', tone: 'success' })
          }}
        />
        <Row
          icon="ellipsis"
          title="Action sheet"
          onPress={async () => {
            const choice = await actionSheet({
              title: 'Invite friends',
              message: 'They can join with the link or by typing the code.',
              actions: [{ label: 'Share Invite Link' }, { label: 'Copy Code' }, { label: 'Reset Code', style: 'destructive' }],
            })
            if (choice) toast(choice)
          }}
        />
        <Row icon="bell" title="Banner" onPress={() => toast({ title: 'Results are in', message: 'Lena gave you 4.5 of 5. Tap to see.', icon: 'trophy' })} />
        <Row icon="sparkles" title="Edge glow (Friday reveal)" onPress={() => glow.play(2600)} />
      </Section>

      <Section header="Glass" footer="Liquid Glass-like material: blur, saturation, rim light and a specular highlight.">
        <div className="g-glass-stage">
          <div className="g-glass-blobs" />
          <GlassSurface className="g-glass-card" radius={28}>
            <Text variant="headline" as="div">
              Film Crew
            </Text>
            <Text variant="subheadline" color="secondary" as="div">
              6 friends · Dinner at Da Enzo
            </Text>
          </GlassSurface>
          <div className="g-row g-glass-buttons">
            <GlassButton icon="chevronLeft" aria-label="Back" />
            <GlassButton icon="share" aria-label="Share" />
            <GlassButton>Edit</GlassButton>
            <GlassButton prominent icon="checkmark" aria-label="Done" />
            <GlassButton prominent icon="checkmark" aria-label="Done (disabled)" disabled />
          </div>
        </div>
      </Section>

      <Section header="Empty state">
        <EmptyState
          icon="person2"
          title="No friends yet"
          message="Stakes only work with witnesses. Invite someone with a link or a code."
          action={<Button icon="share">Invite Friends</Button>}
        />
      </Section>

      <Section header="Type">
        <div className="g-pad g-type">
          <Text variant="largeTitle" as="div">Large Title</Text>
          <Text variant="title1" as="div">Title 1</Text>
          <Text variant="title2" as="div">Title 2</Text>
          <Text variant="title3" as="div">Title 3</Text>
          <Text variant="headline" as="div">Headline</Text>
          <Text variant="body" as="div">Body — the quick brown fox</Text>
          <Text variant="callout" as="div">Callout</Text>
          <Text variant="subheadline" color="secondary" as="div">Subheadline</Text>
          <Text variant="footnote" color="secondary" as="div">Footnote</Text>
          <Text variant="caption1" color="secondary" as="div">Caption 1</Text>
          <Text variant="caption2" color="tertiary" as="div">Caption 2</Text>
          <Text variant="title1" tabular as="div">4d 05:12:09</Text>
        </div>
      </Section>

      <Section header="Icons">
        <div className="g-icons">
          {iconNames.map((n) => (
            <div key={n} className="g-icon">
              <Icon name={n} size={26} />
              <span>{n}</span>
            </div>
          ))}
        </div>
      </Section>

      <Sheet open={declarativeSheet} onClose={() => setDeclarativeSheet(false)} detents={['large']}>
        <NewSpaceSheet onDone={() => setDeclarativeSheet(false)} />
      </Sheet>
    </Screen>
  )
}

function ReviewScreen() {
  const [marks, setMarks] = useState<Record<string, ReviewMark | null>>({})
  const glow = useEdgeGlow()
  const nav = useNav()
  const complete = TASKS.every((t) => marks[t.id] != null)
  return (
    <Screen
      title="Review Lena"
      subtitle="4 tasks · due Friday at midnight"
      toolbar={
        <Button
          size="large"
          fullWidth
          disabled={!complete}
          onClick={() => {
            glow.play(2400)
            nav.pop()
          }}
        >
          Submit Reviews
        </Button>
      }
      toolbarFullWidth
    >
      <Section header="Lena’s week" footer="Marks are final once submitted.">
        {TASKS.map((t) => (
          <div key={t.id} className="g-review-row">
            <Text variant="body" as="div">
              {t.title}
            </Text>
            <MarkPicker value={marks[t.id] ?? null} onChange={(m) => setMarks((x) => ({ ...x, [t.id]: m }))} />
          </div>
        ))}
      </Section>
    </Screen>
  )
}

function DetailScreen({ depth }: { depth: number }) {
  const nav = useNav()
  const toast = useToast()
  const [note, setNote] = useState('')
  return (
    <Screen
      title={depth === 1 ? 'Detail' : `Level ${depth}`}
      trailing={<GlassButton icon="ellipsis" aria-label="More" />}
    >
      <Section header="Navigation" footer="Swipe from the left edge to go back; the gesture follows your finger.">
        <Row title="Push another" chevron onPress={() => nav.push(<DetailScreen depth={depth + 1} />)} />
        {depth > 1 && <Row title="Pop to root" onPress={() => nav.popToRoot()} />}
        <Row title="Pop" onPress={() => nav.pop()} />
      </Section>
      <Section footer="Saves on blur. Type, then swipe back: the gesture ends editing first, so the save still runs.">
        <TextFieldRow label="Note" value={note} onChange={setNote} placeholder="Type, then swipe back" onBlur={() => note && toast(`Saved: ${note}`)} />
      </Section>
      <Section header="Filler">
        {Array.from({ length: 14 }, (_, i) => (
          <Row key={i} title={`Row ${i + 1}`} detail={i % 3 === 0 ? 'Detail' : undefined} chevron={i % 2 === 0} />
        ))}
      </Section>
    </Screen>
  )
}

function PersonScreen({ name, color }: { name: string; color: string }) {
  return (
    <Screen title={name} titleDisplay="inline" trailing={<GlassButton icon="share" aria-label="Share" />}>
      <div className="g-person">
        <Avatar name={name} color={color} size={88} />
        <Text variant="title2" as="div">
          {name}
        </Text>
        <Pill tone="green" icon="flame">
          4-week streak
        </Pill>
      </div>
      <Section header="October">
        <Row title="Week of Oct 6" detail="100%" />
        <Row title="Week of Oct 13" detail="88%" />
        <Row title="Missed reviews" detail="0" />
      </Section>
    </Screen>
  )
}

function SheetDemo({ close }: { close: () => void }) {
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [title, setTitle] = useState('')
  const toast = useToast()
  return (
    <Screen
      title="Next Week"
      titleDisplay="inline"
      leading={<GlassButton icon="xmark" aria-label="Close" onClick={close} />}
      trailing={<GlassButton prominent icon="checkmark" aria-label="Save" onClick={close} />}
    >
      <Section footer="Saves on blur. Type, then drag the sheet down: the save still runs.">
        <TextFieldRow label="Title" value={title} onChange={setTitle} placeholder="Type, then drag down" onBlur={() => title && toast(`Saved: ${title}`)} />
      </Section>
      <Section header="Plan" footer="Drag the grabber up for the large detent, or down to dismiss.">
        {TASKS.map((t) => (
          <Row
            key={t.id}
            title={t.title}
            leading={<CheckCircle checked={!!checked[t.id]} onChange={(v) => setChecked((c) => ({ ...c, [t.id]: v }))} />}
          />
        ))}
      </Section>
      <Section>
        {Array.from({ length: 10 }, (_, i) => (
          <Row key={i} title={`More ${i + 1}`} />
        ))}
      </Section>
    </Screen>
  )
}

function NewSpaceSheet({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [reward, setReward] = useState('')
  return (
    <Screen
      title="New Space"
      titleDisplay="inline"
      leading={<GlassButton icon="xmark" aria-label="Cancel" onClick={onDone} />}
      trailing={<GlassButton prominent icon="checkmark" aria-label="Create" onClick={onDone} disabled={!name} />}
    >
      <Section footer="2 to 8 friends. You can rename it later.">
        <TextFieldRow value={name} onChange={setName} placeholder="Space name" autoFocus />
      </Section>
      <Section header="Stakes" footer="What the others owe a member who hits 90%.">
        <TextArea value={reward} onChange={setReward} placeholder="Dinner on me" minRows={2} />
      </Section>
    </Screen>
  )
}

function FlowDemo({ close }: { close: () => void }) {
  return (
    <NavigationStack
      root={
        <Screen title="Join a Space" leading={<GlassButton icon="xmark" aria-label="Close" onClick={close} />}>
          <FlowStep close={close} />
        </Screen>
      }
    />
  )
}

function FlowStep({ close }: { close: () => void }) {
  const nav = useNav()
  const [code, setCode] = useState('')
  return (
    <>
      <Section footer="Type the 8-character code from your friend, or open their invite link.">
        <TextFieldRow value={code} onChange={(v) => setCode(v.toUpperCase())} placeholder="XXXX-XXXX" autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
      </Section>
      <div className="g-pad-x">
        <Button
          size="large"
          fullWidth
          onClick={() =>
            nav.push(
              <Screen title="You’re in">
                <EmptyState icon="trophy" title="Welcome to Film Crew" message="Plan your first week before Monday midnight." action={<Button onClick={close}>Done</Button>} />
              </Screen>,
              { title: 'Join' },
            )
          }
        >
          Continue
        </Button>
      </div>
      <div className="g-pad-x g-center">
        <Toggle checked={false} onChange={() => {}} aria-label="Demo toggle" />
      </div>
    </>
  )
}

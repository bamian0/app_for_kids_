// Your account: photo, name, your showcase, reminders on this device, sign out, delete account.
import { useEffect, useRef, useState } from 'react'
import { deleteMyAccount, signOut, updateMyName, useAuth, useShowcase } from '../data/api.ts'
import { showcaseSummary, showOf } from '../domain/showcase.ts'
import { disablePush, enablePush, isPushEnabled, preloadPushConfig, pushSupport } from '../push/index.ts'
import type { UID } from '../domain/types.ts'
import { Button, GlassButton, NavigationStack, Row, Screen, Section, TextFieldRow, useAlert, useNav, useToast } from '../ui/index.ts'
import { ErrorText } from './components/Bits.tsx'
import { PROFILE_SHOWCASE_FOOTER } from './friends/copy.ts'
import { ShowcaseEditorScreen } from './friends/ShowcaseEditorScreen.tsx'
import { REMINDER_TIMES } from './help/content.ts'
import { HelpScreen } from './help/HelpSheet.tsx'
import { ProfilePhoto } from './profile/ProfilePhoto.tsx'

interface Props {
  close: () => void
  onInstallGuide: () => void
}

export function ProfileSheet(props: Props) {
  return <NavigationStack root={<ProfileHome {...props} />} />
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong. Try again.'
}

function ProfileHome({ close, onInstallGuide }: Props) {
  const nav = useNav()
  const toast = useToast()
  const auth = useAuth()
  const savedName = auth.profile?.name ?? ''
  const [name, setName] = useState(savedName)
  const [editing, setEditing] = useState(false)

  // Follow the live profile unless you're mid-edit.
  useEffect(() => {
    if (!editing) setName(savedName)
  }, [savedName, editing])

  // An edit still in the field when the sheet goes away (closed with ✓, dragged down) is saved too.
  const unsaved = useRef<{ name: string; saved: string } | null>(null)
  unsaved.current = editing ? { name, saved: savedName } : null
  useEffect(
    () => () => {
      const edit = unsaved.current
      const clean = edit?.name.trim()
      if (edit && clean && clean !== edit.saved) updateMyName(clean).catch(() => {})
    },
    [],
  )

  const saveName = async () => {
    unsaved.current = null
    setEditing(false)
    const clean = name.trim()
    if (!clean || clean === savedName) {
      setName(savedName)
      return
    }
    try {
      await updateMyName(clean)
      toast({ title: 'Name saved', tone: 'success' })
    } catch (e) {
      setName(savedName)
      toast({ title: 'Couldn’t save your name', message: errorText(e), tone: 'error' })
    }
  }

  const doSignOut = async () => {
    close()
    // This device stops getting the reminders meant for this account. Best effort: offline, the
    // delete would wait for the network, so sign-out doesn't wait on it for long.
    if (auth.uid && pushSupport() === 'supported') {
      await Promise.race([disablePush(auth.uid).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2500))])
    }
    try {
      await signOut()
    } catch (e) {
      toast({ title: 'Couldn’t sign out', message: errorText(e), tone: 'error' })
    }
  }

  return (
    <Screen
      title="Profile"
      titleDisplay="inline"
      trailing={<GlassButton prominent icon="checkmark" aria-label="Done" onClick={close} />}
    >
      <div className="s-profile-hero">
        <ProfilePhoto name={name || savedName || '?'} color={auth.profile?.color ?? 'var(--system-gray)'} photo={auth.profile?.photo} />
        <div className="s-profile-hero__name">{savedName || 'No name yet'}</div>
        <div className="s-profile-hero__email">{auth.email}</div>
      </div>

      <Section header="Name" footer="This is what friends see in every space.">
        <TextFieldRow
          value={name}
          onChange={setName}
          placeholder="Your name"
          aria-label="Your name"
          autoComplete="name"
          autoCapitalize="words"
          maxLength={40}
          enterKeyHint="done"
          onFocus={() => setEditing(true)}
          onBlur={() => void saveName()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
      </Section>

      {auth.uid && <ShowcaseSection uid={auth.uid} />}

      {auth.uid && <NotificationsSection uid={auth.uid} onInstallGuide={onInstallGuide} />}

      <Section>
        <Row icon="info" title="How Stakes Works" chevron onPress={() => nav.push(<HelpScreen />, { title: 'How Stakes Works' })} />
      </Section>

      <Section>
        <Row title="Sign Out" destructive onPress={doSignOut} />
      </Section>
      <Section footer="Removes you from every space and deletes your profile.">
        <Row title="Delete Account" destructive chevron onPress={() => nav.push(<DeleteAccountScreen close={close} />, { title: 'Delete Account' })} />
      </Section>
    </Screen>
  )
}

/** What anyone on Stakes sees on your profile (SPEC §11.9.4): the switches live in the editor. */
function ShowcaseSection({ uid }: { uid: UID }) {
  const nav = useNav()
  const showcase = useShowcase(uid)
  const detail = showcase.data === undefined ? undefined : showcaseSummary(showOf(showcase.data))
  return (
    <Section footer={PROFILE_SHOWCASE_FOOTER}>
      <Row icon="person2" title="Showcase" detail={detail} chevron onPress={() => nav.push(<ShowcaseEditorScreen />, { title: 'Showcase' })} />
    </Section>
  )
}

function NotificationsSection({ uid, onInstallGuide }: { uid: UID; onInstallGuide: () => void }) {
  const toast = useToast()
  const support = pushSupport()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [denied, setDenied] = useState(() => typeof Notification !== 'undefined' && Notification.permission === 'denied')

  useEffect(() => {
    if (support !== 'supported') return
    void preloadPushConfig()
    let live = true
    isPushEnabled().then((on) => live && setEnabled(on))
    return () => {
      live = false
    }
  }, [support])

  const toggle = (on: boolean) => {
    if (busy) return
    if (on) {
      // Called straight from the tap: Safari only shows the permission prompt inside the gesture.
      const pending = enablePush(uid)
      setBusy(true)
      setEnabled(true)
      pending
        .then((ok) => {
          setEnabled(ok)
          if (!ok && Notification.permission === 'denied') setDenied(true)
          if (ok) toast({ title: 'Reminders on', icon: 'bell' })
        })
        .catch((e: unknown) => {
          setEnabled(false)
          toast({ title: 'Couldn’t turn on reminders', message: errorText(e), tone: 'error' })
        })
        .finally(() => setBusy(false))
      return
    }
    setBusy(true)
    setEnabled(false)
    disablePush(uid)
      .catch((e: unknown) => {
        setEnabled(true)
        toast({ title: 'Couldn’t turn off reminders', message: errorText(e), tone: 'error' })
      })
      .finally(() => setBusy(false))
  }

  if (support === 'needs-install') {
    return (
      <Section header="Notifications" footer="iPhone only sends reminders to apps on the Home Screen.">
        <Row icon="bell" title="Reminders" subtitle="Add Stakes to your Home Screen first" chevron onPress={onInstallGuide} />
      </Section>
    )
  }
  if (support === 'unsupported') {
    return (
      <Section header="Notifications" footer="This browser can’t receive reminders.">
        <Row icon="bellSlash" title="Reminders" detail="Not available" />
      </Section>
    )
  }
  if (denied) {
    return (
      <Section header="Notifications" footer="Notifications are blocked for Stakes. Allow them in Settings › Notifications › Stakes, then come back.">
        <Row icon="bellSlash" title="Reminders" detail="Blocked" />
      </Section>
    )
  }
  return (
    <Section header="Notifications" footer={`On this device: ${REMINDER_TIMES}`}>
      <Row icon="bell" title="Reminders" toggle={enabled === true} onToggle={toggle} disabled={enabled === null || busy} />
    </Section>
  )
}

function DeleteAccountScreen({ close }: { close: () => void }) {
  const { confirm } = useAlert()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async () => {
    if (busy) return
    const ok = await confirm({
      title: 'Delete your account?',
      message: 'You’ll leave every space and your profile is deleted. This can’t be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      await deleteMyAccount(password)
      close()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <Screen title="Delete Account" titleDisplay="inline">
      <Section header="Confirm with your password" footer={error ? <ErrorText>{error}</ErrorText> : 'Friends keep the weeks you already played together.'}>
        <TextFieldRow
          type="password"
          value={password}
          onChange={setPassword}
          placeholder="Password"
          aria-label="Password"
          autoComplete="current-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
        />
      </Section>
      <div className="s-form-actions">
        <Button variant="destructive" size="large" fullWidth loading={busy} disabled={!password} onClick={remove}>
          Delete Account
        </Button>
      </div>
    </Screen>
  )
}

// Join with a code or a pasted link: formats as you type, previews the space, then joins.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { joinSpace, lookupFriendCode, lookupInvite, useMySpaces } from '../data/api.ts'
import { INVITE_ALPHABET, INVITE_CODE_LENGTH, normalizeInviteCode } from '../domain/ids.ts'
import type { Invite } from '../domain/types.ts'
import { ActivityIndicator, Avatar, Button, GlassButton, Row, Screen, Section, TextFieldRow } from '../ui/index.ts'
import { ErrorText } from './components/Bits.tsx'
import { listNames } from './components/people.ts'
import { StakesList } from './components/Stakes.tsx'
import { JUDGE_FOOTER_NEW } from './space/space.ts'

/** Keeps the field as XXXX-XXXX while typing; a pasted invite link becomes its code. */
export function formatCodeInput(value: string): string {
  const fromLink = /join=|:\/\//i.test(value) ? normalizeInviteCode(value) : null
  const raw = (fromLink ?? value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, INVITE_CODE_LENGTH)
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw
}

/** `friendCode`: no space uses the code, but it is someone's friend code (yours included). */
type Lookup = { code: string; invite: Invite | null; error: string | null; friendCode?: boolean }

interface Props {
  close: () => void
  initialCode?: string
  /** `fresh` is false when you were already in the space and just opened it. */
  onJoined: (spaceId: string, spaceName: string | undefined, fresh: boolean) => void
}

export function JoinSheet({ close, initialCode, onJoined }: Props) {
  const [value, setValue] = useState(() => formatCodeInput(initialCode ?? ''))
  const [lookup, setLookup] = useState<Lookup | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [judge, setJudge] = useState(false)
  const code = normalizeInviteCode(value)
  const typed = value.replace('-', '')

  useEffect(() => {
    if (!code) return
    let live = true
    lookupInvite(code).then(
      (invite) => {
        if (!live) return
        setLookup({ code, invite, error: null })
        // A miss may be a friend code typed in the wrong place (SPEC §11.6): one more read, only on a miss.
        if (!invite)
          lookupFriendCode(code).then(
            () => live && setLookup({ code, invite: null, error: null, friendCode: true }),
            (e: unknown) => live && e instanceof Error && e.message === 'That’s your own code.' && setLookup({ code, invite: null, error: null, friendCode: true }),
          )
      },
      (e: unknown) => live && setLookup({ code, invite: null, error: e instanceof Error ? e.message : 'Couldn’t check this code.' }),
    )
    return () => {
      live = false
    }
  }, [code])

  const result = lookup && lookup.code === code ? lookup : null
  const invite = result?.invite ?? null
  const mySpaces = useMySpaces()
  const alreadyIn = !!invite && !!mySpaces.data?.some((s) => s.id === invite.spaceId)

  const join = async () => {
    if (!code || busy) return
    setBusy(true)
    setError(null)
    try {
      const spaceId = await joinSpace(code, judge ? { judge } : {})
      onJoined(spaceId, invite?.spaceName, true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t join.')
      setBusy(false)
    }
  }

  const go = invite && alreadyIn ? () => onJoined(invite.spaceId, invite.spaceName, false) : join

  let hint: ReactNode = 'The 8-character code from your friend, or paste their invite link.'
  if (typed.length === INVITE_CODE_LENGTH && !code) {
    const bad = [...typed].filter((c) => !INVITE_ALPHABET.includes(c))
    hint = <ErrorText>Codes never use {listNames([...new Set(bad)].map((c) => `“${c}”`))}. Check the code with your friend.</ErrorText>
  } else if (result?.error) {
    hint = <ErrorText>{result.error}</ErrorText>
  } else if (result?.friendCode) {
    hint = <ErrorText>That’s a friend code. Add them in Friends.</ErrorText>
  } else if (result && !invite) {
    hint = <ErrorText>No space uses this code. Check it with your friend.</ErrorText>
  }

  return (
    <Screen
      title="Join a Space"
      titleDisplay="inline"
      leading={<GlassButton icon="xmark" aria-label="Cancel" onClick={close} />}
      // Floats above the keyboard, so the code field can keep focus.
      toolbar={
        invite ? (
          <Button size="large" fullWidth loading={busy} onClick={go}>
            {alreadyIn ? `Open ${invite.spaceName}` : `Join ${invite.spaceName}`}
          </Button>
        ) : undefined
      }
      toolbarFullWidth
    >
      <Section footer={hint}>
        <TextFieldRow
          className="s-code-field"
          value={value}
          onChange={(v) => {
            setError(null)
            setValue(formatCodeInput(v))
          }}
          placeholder="XXXX-XXXX"
          aria-label="Invite code"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          autoFocus={!initialCode}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && invite) void go()
          }}
        />
      </Section>

      {code && !result && (
        <div className="s-center-pad">
          <ActivityIndicator color="var(--secondary-label)" label="Checking code" />
        </div>
      )}

      {invite && (
        <>
          <Section padded footer={error ? <ErrorText>{error}</ErrorText> : undefined}>
            <div className="s-join-preview">
              <Avatar name={invite.spaceName} color="var(--system-gray)" size={56} />
              <div className="s-join-preview__title">{alreadyIn ? invite.spaceName : `Join ${invite.spaceName}`}</div>
              <div className="s-join-preview__text">{alreadyIn ? 'You’re already in this space.' : `Invited by ${invite.inviterName}`}</div>
            </div>
          </Section>
          {!alreadyIn && invite.reward && invite.penalty && (
            <Section header="What’s at stake" footer="Everyone can set their own stakes after joining. Until you agree to theirs, these count.">
              <StakesList reward={invite.reward} penalty={invite.penalty} />
            </Section>
          )}
          {!alreadyIn && (
            <Section footer={JUDGE_FOOTER_NEW}>
              <Row title="Only Rate Friends" toggle={judge} onToggle={setJudge} />
            </Section>
          )}
        </>
      )}
    </Screen>
  )
}

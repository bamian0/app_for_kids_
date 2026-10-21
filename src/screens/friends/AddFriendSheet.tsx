// Add Friend (SPEC §11.9.2): your link and code to share, a field for someone else's code or link, and everyone
// from your spaces who isn't a friend yet. A sheet with its own stack, so a person's showcase opens inside it.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { friendLink, lookupFriendCode, resetFriendCode, useAuth, useMyFriendCode } from '../../data/api.ts'
import { isSpaceInviteLink, normalizeFriendCode } from '../../domain/friends.ts'
import { formatInviteCode } from '../../domain/ids.ts'
import type { FriendLookup } from '../../domain/types.ts'
import { ActivityIndicator, Button, GlassButton, NavigationStack, Row, Screen, Section, TextFieldRow, useAlert, useNav, useToast } from '../../ui/index.ts'
import { ErrorText } from '../components/Bits.tsx'
import { useNow } from '../components/clock.ts'
import { personOf } from '../components/people.ts'
import { copyText, shareOrCopy } from '../components/share.ts'
import { PEOPLE_SHEET_FOOTER, RESET_CONFIRM, shareLinkData, spacesSubtitle } from './copy.ts'
import { PersonRow, RelationAction, errorText, personFor, relationTo, useFriendActions, usePeopleInSpaces, useView } from './parts.tsx'
import { ShowcaseScreen } from './ShowcaseScreen.tsx'

interface Props {
  close: () => void
  /** A friend link's code (?friend=): the field starts with it and looks it up. */
  initialCode?: string
}

export function AddFriendSheet(props: Props) {
  return <NavigationStack root={<AddFriendHome {...props} />} />
}

/** What the field shows: a pasted friend link becomes its code; anything else is kept as typed, in capitals. */
export function formatFriendInput(value: string): string {
  if (/friend=|:\/\//i.test(value)) {
    const code = normalizeFriendCode(value)
    if (code) return formatInviteCode(code)
    return value
  }
  return value.toUpperCase()
}

type Lookup = { code: string; found: FriendLookup | null; error: string | null }

function AddFriendHome({ close, initialCode }: Props) {
  const nav = useNav()
  const [value, setValue] = useState(() => (initialCode ? formatInviteCode(initialCode) : ''))
  const code = normalizeFriendCode(value)
  const spaceInvite = !code && isSpaceInviteLink(value)
  const [lookup, setLookup] = useState<Lookup | null>(null)

  useEffect(() => {
    if (!code) return
    let live = true
    lookupFriendCode(code).then(
      (found) => live && setLookup({ code, found, error: null }),
      (e: unknown) => live && setLookup({ code, found: null, error: errorText(e, 'Couldn’t check this code.') }),
    )
    return () => {
      live = false
    }
  }, [code])

  const result = lookup && lookup.code === code ? lookup : null
  const { view } = useView()
  const { people, profiles } = usePeopleInSpaces(view, true)
  const open = (uid: string, name: string) => nav.push(<ShowcaseScreen uid={uid} name={name} />, { title: name })

  let hint: ReactNode = undefined
  if (spaceInvite) hint = <ErrorText>That’s a space invite. Join it from Spaces.</ErrorText>
  else if (result?.error) hint = <ErrorText>{result.error}</ErrorText>

  return (
    <Screen title="Add Friend" titleDisplay="inline" trailing={<GlassButton prominent icon="checkmark" aria-label="Done" onClick={close} />}>
      <YourLink />

      <Section header="Add with a code" footer={hint}>
        <TextFieldRow
          value={value}
          onChange={(v) => setValue(formatFriendInput(v))}
          placeholder="Friend’s code or link"
          aria-label="Friend’s code or link"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
        />
        {code && !result && (
          <div className="fr-lookup">
            <ActivityIndicator color="var(--secondary-label)" label="Checking code" />
          </div>
        )}
        {result?.found && <FoundRow found={result.found} onOpen={open} />}
      </Section>

      {people.length > 0 && (
        <Section header="People in Your Spaces" footer={PEOPLE_SHEET_FOOTER}>
          {people.map((p) => {
            const person = personFor(profiles, p.uid)
            return <PersonInSpacesRow key={p.uid} uid={p.uid} name={person.name} subtitle={spacesSubtitle(p.spaces)} profiles={profiles} onOpen={open} />
          })}
        </Section>
      )}
    </Screen>
  )
}

function FoundRow({ found, onOpen }: { found: FriendLookup; onOpen: (uid: string, name: string) => void }) {
  const { uid: me } = useAuth()
  const { view } = useView()
  const nowMs = useNow()
  const actions = useFriendActions()
  const person = personOf({ [found.uid]: found.profile }, found.uid)
  return (
    <PersonRow
      person={person}
      onOpen={() => onOpen(found.uid, person.name)}
      trailing={<RelationAction uid={found.uid} name={person.name} rel={relationTo(view, me, found.uid, nowMs)} actions={actions} />}
    />
  )
}

function PersonInSpacesRow({
  uid,
  name,
  subtitle,
  profiles,
  onOpen,
}: {
  uid: string
  name: string
  subtitle: string
  profiles: ReturnType<typeof usePeopleInSpaces>['profiles']
  onOpen: (uid: string, name: string) => void
}) {
  const { uid: me } = useAuth()
  const { view } = useView()
  const nowMs = useNow()
  const actions = useFriendActions()
  return (
    <PersonRow
      person={personFor(profiles, uid)}
      subtitle={subtitle}
      onOpen={() => onOpen(uid, name)}
      trailing={<RelationAction uid={uid} name={name} rel={relationTo(view, me, uid, nowMs)} actions={actions} />}
    />
  )
}

/** Your code, big, with Share Link and Copy Code; Reset Link in its own section. */
function YourLink() {
  const toast = useToast()
  const { confirm } = useAlert()
  const live = useMyFriendCode()
  const [resetting, setResetting] = useState(false)
  const code = live.data

  const share = async () => {
    if (!code) return
    const link = friendLink(code)
    const result = await shareOrCopy(shareLinkData(link))
    if (result === 'copied') toast({ title: 'Link copied', icon: 'link' })
    if (result === 'failed') toast({ title: 'Couldn’t share', message: link, tone: 'error' })
  }
  const copy = async () => {
    if (!code) return
    const text = formatInviteCode(code)
    toast((await copyText(text)) ? { title: 'Code copied', icon: 'copy' } : { title: 'Couldn’t copy', message: text, tone: 'error' })
  }
  const reset = async () => {
    const ok = await confirm({ ...RESET_CONFIRM })
    if (!ok) return
    setResetting(true)
    try {
      await resetFriendCode()
      toast({ title: 'New link ready', icon: 'link' })
    } catch (e) {
      toast({ title: 'Couldn’t reset your link', message: errorText(e), tone: 'error' })
    } finally {
      setResetting(false)
    }
  }

  return (
    <>
      <Section header="Your link" footer="Anyone with your link or code can ask to be your friend. Nothing changes until you accept.">
        <div className="fr-code">
          {code ? (
            <>
              <div className="fr-code__value" aria-label={`Your code ${code.split('').join(' ')}`}>
                {formatInviteCode(code)}
              </div>
              <div className="fr-code__actions">
                <Button fullWidth icon="share" onClick={() => void share()}>
                  Share Link
                </Button>
                <Button fullWidth variant="gray" icon="copy" onClick={() => void copy()}>
                  Copy Code
                </Button>
              </div>
            </>
          ) : (
            <div className="fr-code__wait">{live.error ? 'Your link shows up when you’re online.' : 'Getting your link…'}</div>
          )}
        </div>
      </Section>
      <Section footer="Shared your link too widely? Reset it.">
        <Row
          title="Reset Link"
          action
          disabled={!code || resetting}
          accessory={resetting ? <ActivityIndicator color="var(--secondary-label)" label="Resetting" /> : undefined}
          onPress={() => void reset()}
        />
      </Section>
    </>
  )
}

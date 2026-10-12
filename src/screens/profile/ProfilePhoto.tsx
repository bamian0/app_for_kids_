// Your avatar in the Profile sheet: tap it to choose a photo, take one or remove it (SPEC §7.3). A new
// photo shows at once, with a spinner until the server has it.
import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { updateMyPhoto } from '../../data/api.ts'
import { ActivityIndicator, Avatar, useAlert, useSheet, useToast } from '../../ui/index.ts'
import type { DialogAction } from '../../ui/index.ts'
import { usePress } from '../../ui/press.ts'
import { openPhoto, PhotoError } from './image.ts'
import { PhotoCropSheet } from './PhotoCropSheet.tsx'
import './profile.css'

/** Offline, a save waits for the network; the photo is in the local cache already, so the spinner stops here. */
const SPINNER_MAX_MS = 8000

const CHOOSE = 'Choose Photo'
const TAKE = 'Take Photo'
const REMOVE = 'Remove Photo'

/** Phones and tablets: a desktop browser opens the same file dialog for Take Photo. */
const hasCamera = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong. Try again.'
}

export interface ProfilePhotoProps {
  name: string
  color: string
  photo?: string
  size?: number
}

export function ProfilePhoto({ name, color, photo, size = 84 }: ProfilePhotoProps) {
  const { actionSheet, confirm } = useAlert()
  const sheet = useSheet()
  const toast = useToast()
  const { pressed, handlers } = usePress(true)
  const library = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  // The photo being saved (null: being removed), shown in place of the stored one meanwhile.
  const [saving, setSaving] = useState<{ photo: string | null } | null>(null)
  const [opening, setOpening] = useState(false)
  const saves = useRef(0)
  const shown = saving ? (saving.photo ?? undefined) : photo
  const busy = saving !== null || opening

  const save = async (next: string | null) => {
    const id = ++saves.current
    setSaving({ photo: next })
    const done = () => {
      if (saves.current === id) setSaving(null)
    }
    const timer = setTimeout(done, SPINNER_MAX_MS)
    try {
      await updateMyPhoto(next)
    } catch (e) {
      toast({ title: next ? 'Couldn’t save your photo' : 'Couldn’t remove your photo', message: errorText(e), tone: 'error' })
    } finally {
      clearTimeout(timer)
      done()
    }
  }

  const picked = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget
    const file = input.files?.[0]
    // Cleared, so picking the same photo again still counts as a change.
    input.value = ''
    if (!file) return
    setOpening(true)
    try {
      const image = await openPhoto(file)
      sheet.present((close) => <PhotoCropSheet image={image} close={close} onChoose={(p) => void save(p)} />, {
        presentation: 'fullScreen',
        'aria-label': 'Move and Scale',
      })
    } catch (err) {
      const known = err instanceof PhotoError
      toast({ title: known ? err.title : 'Couldn’t open this photo', message: known ? err.message : 'Try a different one.', tone: 'error' })
    } finally {
      setOpening(false)
    }
  }

  const menu = async () => {
    if (busy) return
    // The pickers open from inside the tap (onPress), or Safari refuses to open them.
    const actions: DialogAction[] = [{ label: CHOOSE, onPress: () => library.current?.click() }]
    if (hasCamera()) actions.push({ label: TAKE, onPress: () => camera.current?.click() })
    if (shown) actions.push({ label: REMOVE, style: 'destructive' })
    const choice = await actionSheet({ actions })
    if (choice !== REMOVE) return
    const ok = await confirm({
      title: 'Remove your photo?',
      message: 'Friends will see your initials instead.',
      confirmLabel: 'Remove',
      destructive: true,
    })
    if (ok) void save(null)
  }

  return (
    <>
      <button
        type="button"
        className="p-avatar"
        aria-label={shown ? 'Change your photo' : 'Add a photo'}
        aria-busy={busy || undefined}
        data-pressed={pressed || undefined}
        onClick={() => void menu()}
        {...handlers}
      >
        <span className="p-avatar__clip">
          <Avatar name={name} color={color} photo={shown} size={size} />
          <span className="p-avatar__band" aria-hidden>
            Edit
          </span>
          {busy && (
            <span className="p-avatar__busy">
              <ActivityIndicator size={Math.round(size * 0.3)} label={opening ? 'Opening photo' : 'Saving photo'} />
            </span>
          )}
        </span>
      </button>
      <input ref={library} className="ui-visually-hidden" type="file" accept="image/*" tabIndex={-1} aria-hidden onChange={(e) => void picked(e)} />
      <input ref={camera} className="ui-visually-hidden" type="file" accept="image/*" capture="user" tabIndex={-1} aria-hidden onChange={(e) => void picked(e)} />
    </>
  )
}

// The invite code, big and easy to read aloud, with Copy and Share.
import { inviteLink } from '../../data/api.ts'
import { formatInviteCode } from '../../domain/ids.ts'
import type { Space } from '../../domain/types.ts'
import { Row, Section, useToast } from '../../ui/index.ts'
import { copyText, shareOrCopy } from './share.ts'

export function InviteCard({ space, footer }: { space: Space; footer?: string }) {
  const toast = useToast()
  const code = formatInviteCode(space.inviteCode)

  const copy = async () => {
    toast((await copyText(code)) ? { title: 'Code copied', icon: 'copy' } : { title: 'Couldn’t copy', message: code, tone: 'error' })
  }

  const share = async () => {
    const result = await shareOrCopy({
      title: `Join ${space.name} on Stakes`,
      text: `Join “${space.name}” on Stakes. If the link doesn’t open, use code ${code}.`,
      url: inviteLink(space),
    })
    if (result === 'copied') toast({ title: 'Link copied', icon: 'link' })
    if (result === 'failed') toast({ title: 'Couldn’t share', message: inviteLink(space), tone: 'error' })
  }

  return (
    <>
      <Section padded>
        <div className="s-invite">
          <div className="s-invite__label">Invite code</div>
          <div className="s-invite__code" aria-label={`Invite code ${space.inviteCode.split('').join(' ')}`}>
            {code}
          </div>
          <div className="s-invite__hint">Not case-sensitive. No 0, O, 1 or I.</div>
        </div>
      </Section>
      <Section
        footer={
          footer ??
          'Friends who open Stakes from their Home Screen should type the code: links open in Safari, which keeps a separate sign-in.'
        }
      >
        <Row icon="copy" iconBackground="var(--system-gray)" title="Copy Code" onPress={copy} />
        <Row icon="share" iconBackground="var(--system-gray)" title="Share Invite Link" onPress={share} />
      </Section>
    </>
  )
}

// The stakes as rows: reward and penalty (the space, the invite and the join preview), and any list of stakes
// rows with their icons (the stakes card, the Stakes screen: streak rewards, a friend's terms as they apply to you).
import { Icon } from '../../ui/index.ts'

export function StakesList({ reward, penalty, threshold = 90 }: { reward: string; penalty: string; threshold?: number }) {
  return (
    <StakesItems
      items={[
        { icon: 'trophy', label: `Hit ${threshold}%, they owe you`, text: reward },
        { icon: 'flame', label: 'Miss, you owe them', text: penalty },
      ]}
    />
  )
}

export interface StakesItem {
  icon: 'trophy' | 'flame' | 'sparkles'
  label: string
  text: string
  /** A small line under the text ("Together with everyone"). */
  note?: string
}

/** "Lena: A beer · Sam: A paperback · Kim: Flowers" wraps after a dot, never before one: a line never starts
 *  with "·". */
function keepDots(text: string): string {
  return text.replaceAll(' · ', '\u00a0· ')
}

/** Stakes rows: an icon tile (filled for what you're owed), a small label, then the text. */
export function StakesItems({ items }: { items: StakesItem[] }) {
  return (
    <div className="s-stakes">
      {items.map((item, i) => (
        <div className="s-stakes__item" key={`${item.icon}-${i}`}>
          <span className={item.icon === 'flame' ? 's-stakes__icon' : 's-stakes__icon s-stakes__icon--win'} aria-hidden>
            <Icon name={item.icon} size={18} weight={2} />
          </span>
          <span className="s-stakes__text">
            <span className="s-stakes__label">{item.label}</span>
            <span className="s-stakes__value">{keepDots(item.text)}</span>
            {item.note && <span className="s-stakes__label">{item.note}</span>}
          </span>
        </div>
      ))}
    </div>
  )
}

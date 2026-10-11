// The two stakes, reward and penalty, as the space, the invite and the join preview show them.
import { Icon } from '../../ui/index.ts'

export function StakesList({ reward, penalty, threshold = 90 }: { reward: string; penalty: string; threshold?: number }) {
  return (
    <div className="s-stakes">
      <div className="s-stakes__item">
        <span className="s-stakes__icon s-stakes__icon--win" aria-hidden>
          <Icon name="trophy" size={18} weight={2} />
        </span>
        <span className="s-stakes__text">
          <span className="s-stakes__label">Hit {threshold}%, they owe you</span>
          <span className="s-stakes__value">{reward}</span>
        </span>
      </div>
      <div className="s-stakes__item">
        <span className="s-stakes__icon" aria-hidden>
          <Icon name="flame" size={18} weight={2} />
        </span>
        <span className="s-stakes__text">
          <span className="s-stakes__label">Miss, you owe them</span>
          <span className="s-stakes__value">{penalty}</span>
        </span>
      </div>
    </div>
  )
}

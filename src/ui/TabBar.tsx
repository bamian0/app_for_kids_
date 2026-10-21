// UITabBarController for the web: one NavigationStack per tab, all kept mounted so each tab keeps its
// screens and scroll positions, under an iOS 26 floating glass tab bar. The bar steps aside while the
// keyboard is up and while the active tab shows a screen pushed on top of its root.
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { GlassSurface } from './Glass.tsx'
import { Icon } from './icons.tsx'
import type { IconName } from './icons.tsx'
import { springs } from './motion.ts'
import { NavigationStack, useNav } from './NavigationStack.tsx'
import { cx, usePress } from './press.ts'
import './tabbar.css'

export interface TabItem<T extends string = string> {
  id: T
  title: string
  icon: IconName
  /** A red count at the icon's top trailing corner ("9+" above 9), like an app badge; 0 or absent hides it.
   *  VoiceOver reads "Friends, 2 new". */
  badge?: number
}

export interface TabBarProps<T extends string = string> {
  items: TabItem<T>[]
  selected: T
  onSelect: (id: T) => void
  /** Slides the bar away (a pushed screen, the keyboard); it can't be reached while hidden. */
  hidden?: boolean
  /** Prefix for the tab ids, so each tab can name the panel it controls. */
  idPrefix?: string
  className?: string
}

/** The floating capsule on its own. TabView puts it to work. */
export function TabBar<T extends string>({ items, selected, onSelect, hidden, idPrefix, className }: TabBarProps<T>) {
  const index = Math.max(0, items.findIndex((item) => item.id === selected))
  const buttons = useRef<Array<HTMLButtonElement | null>>([])

  // Arrow keys move between tabs, like any tablist.
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const last = items.length - 1
    const next = e.key === 'ArrowRight' ? index + 1 : e.key === 'ArrowLeft' ? index - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? last : null
    if (next === null) return
    e.preventDefault()
    const to = (next + items.length) % items.length
    onSelect(items[to].id)
    buttons.current[to]?.focus()
  }

  return (
    <div className={cx('ui-tab-bar', className)} data-hidden={hidden || undefined} inert={hidden} aria-hidden={hidden || undefined}>
      <GlassSurface className="ui-tab-bar__capsule">
        <div
          className="ui-tab-bar__items"
          role="tablist"
          aria-label="Tabs"
          onKeyDown={onKeyDown}
          data-count={items.length}
          style={{ gridTemplateColumns: `repeat(${items.length}, 1fr)` }}
        >
          <motion.span
            className="ui-tab-bar__pill"
            aria-hidden
            style={{ width: `${100 / items.length}%` }}
            initial={false}
            animate={{ x: `${index * 100}%` }}
            transition={springs.snappy}
          />
          {items.map((item, i) => (
            <TabButton
              key={item.id}
              item={item}
              selected={i === index}
              id={idPrefix ? `${idPrefix}-tab-${item.id}` : undefined}
              controls={idPrefix ? `${idPrefix}-panel-${item.id}` : undefined}
              buttonRef={(el) => {
                buttons.current[i] = el
              }}
              onPress={() => onSelect(item.id)}
            />
          ))}
        </div>
      </GlassSurface>
    </div>
  )
}

interface TabButtonProps {
  item: TabItem
  selected: boolean
  id?: string
  controls?: string
  buttonRef: (el: HTMLButtonElement | null) => void
  onPress: () => void
}

function TabButton({ item, selected, id, controls, buttonRef, onPress }: TabButtonProps) {
  const { pressed, handlers } = usePress(true, 30)
  const badge = item.badge !== undefined && Number.isFinite(item.badge) && item.badge > 0 ? Math.floor(item.badge) : 0
  return (
    <button
      ref={buttonRef}
      type="button"
      role="tab"
      id={id}
      aria-controls={controls}
      aria-selected={selected}
      aria-label={badge > 0 ? `${item.title}, ${badge} new` : undefined}
      tabIndex={selected ? 0 : -1}
      className={cx('ui-tab-bar__item', selected && 'is-selected')}
      data-pressed={pressed || undefined}
      onClick={onPress}
      {...handlers}
    >
      <span className="ui-tab-bar__glyph">
        <Icon name={item.icon} size={25} weight={selected ? 2 : 1.8} className="ui-tab-bar__icon" />
        <AnimatePresence initial={false}>
          {badge > 0 && (
            <motion.span
              key="badge"
              className={cx('ui-tab-bar__badge', badge > 9 && 'is-wide')}
              aria-hidden
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.4, opacity: 0 }}
              transition={springs.bouncy}
            >
              {badge > 9 ? '9+' : badge}
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      <span className="ui-tab-bar__label">{item.title}</span>
    </button>
  )
}

// ---------- TabView ----------

export interface TabApi<T extends string = string> {
  selected: T
  /** Switches tabs; the stacks keep their screens. */
  select: (id: T) => void
}

const TabContext = createContext<TabApi | null>(null)

/** The nearest TabView (null outside one, e.g. in a sheet or before sign-in). */
export function useTabBar(): TabApi | null {
  return useContext(TabContext)
}

export interface Tab<T extends string = string> extends TabItem<T> {
  /** The tab's root screen. */
  root: ReactNode
}

export interface TabViewProps<T extends string = string> {
  tabs: Tab<T>[]
  selected: T
  onSelect: (id: T) => void
}

interface StackHandle {
  popToRoot: () => void
}

export function TabView<T extends string>({ tabs, selected, onSelect }: TabViewProps<T>) {
  const prefix = useId().replace(/:/g, '')
  const [depths, setDepths] = useState<Record<string, number>>({})
  const stacks = useRef(new Map<string, StackHandle>())
  const panels = useRef(new Map<string, HTMLDivElement>())

  const report = useCallback((id: string, depth: number, handle: StackHandle) => {
    stacks.current.set(id, handle)
    setDepths((d) => (d[id] === depth ? d : { ...d, [id]: depth }))
  }, [])

  const select = useCallback(
    (id: T) => {
      if (id !== selected) {
        onSelect(id)
        return
      }
      // Tapping the selected tab goes back to its root, and at the root scrolls it to the top.
      if ((depths[id] ?? 0) > 0) stacks.current.get(id)?.popToRoot()
      else panels.current.get(id)?.querySelector('.ui-nav__page .ui-screen__scroll')?.scrollTo({ top: 0, behavior: 'smooth' })
    },
    [selected, onSelect, depths],
  )

  // Stable while onSelect is, so screens can keep it in effect dependencies.
  const switchTo = useCallback((id: string) => onSelect(id as T), [onSelect])
  const api = useMemo<TabApi>(() => ({ selected, select: switchTo }), [selected, switchTo])

  return (
    <TabContext.Provider value={api}>
      <div className="ui-tabs">
        {tabs.map((tab) => {
          const active = tab.id === selected
          return (
            <div
              key={tab.id}
              ref={(el) => {
                if (el) panels.current.set(tab.id, el)
                else panels.current.delete(tab.id)
              }}
              id={`${prefix}-panel-${tab.id}`}
              role="tabpanel"
              aria-labelledby={`${prefix}-tab-${tab.id}`}
              className={cx('ui-tabs__panel', active && 'is-active')}
              inert={!active}
              aria-hidden={!active || undefined}
            >
              <NavigationStack
                root={
                  <TabRoot id={tab.id} report={report}>
                    {tab.root}
                  </TabRoot>
                }
              />
            </div>
          )
        })}
        <TabBar items={tabs} selected={selected} onSelect={select} hidden={(depths[selected] ?? 0) > 0} idPrefix={prefix} />
      </div>
    </TabContext.Provider>
  )
}

/** Sits at the root of each tab's stack and tells the TabView how deep the stack is. */
function TabRoot({ id, report, children }: { id: string; report: (id: string, depth: number, handle: StackHandle) => void; children: ReactNode }) {
  // Where the stack is heading, so the bar slides back in with a pop rather than after it.
  const { toDepth, popToRoot } = useNav()
  useEffect(() => {
    report(id, toDepth, { popToRoot })
  }, [id, toDepth, popToRoot, report])
  return <>{children}</>
}

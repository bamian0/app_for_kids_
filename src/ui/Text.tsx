import type { CSSProperties, ElementType, ReactNode } from 'react'
import { cx } from './press.ts'

export type TextVariant =
  | 'largeTitle'
  | 'title1'
  | 'title2'
  | 'title3'
  | 'headline'
  | 'body'
  | 'callout'
  | 'subheadline'
  | 'footnote'
  | 'caption1'
  | 'caption2'

export type TextColor = 'label' | 'secondary' | 'tertiary' | 'red' | 'green' | 'inherit'

const VARIANT_CLASS: Record<TextVariant, string> = {
  largeTitle: 't-large-title',
  title1: 't-title1',
  title2: 't-title2',
  title3: 't-title3',
  headline: 't-headline',
  body: 't-body',
  callout: 't-callout',
  subheadline: 't-subheadline',
  footnote: 't-footnote',
  caption1: 't-caption1',
  caption2: 't-caption2',
}

export interface TextProps {
  variant?: TextVariant
  color?: TextColor
  weight?: 'regular' | 'medium' | 'semibold' | 'bold'
  /** Tabular figures for scores and countdowns. */
  tabular?: boolean
  rounded?: boolean
  align?: 'left' | 'center' | 'right'
  as?: ElementType
  className?: string
  style?: CSSProperties
  children?: ReactNode
}

/** Typography on the iOS Dynamic Type scale. Also available as classes: t-body, t-footnote, c-secondary, t-tabular… */
export function Text({ variant = 'body', color = 'label', weight, tabular, rounded, align, as: Tag = 'span', className, style, children }: TextProps) {
  return (
    <Tag
      className={cx(
        VARIANT_CLASS[variant],
        color !== 'inherit' && `c-${color}`,
        weight && `t-${weight}`,
        tabular && 't-tabular',
        rounded && 't-rounded',
        className,
      )}
      style={align ? { textAlign: align, ...style } : style}
    >
      {children}
    </Tag>
  )
}

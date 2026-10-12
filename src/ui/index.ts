// Stakes design system. See src/ui/README.md for the catalogue.
import './global.css'

export { UIProvider, setTheme } from './UIProvider.tsx'
export type { Theme, UIProviderProps } from './UIProvider.tsx'

export { NavigationStack, useNav, useNavPage } from './NavigationStack.tsx'
export type { NavApi, NavigationStackProps, PushOptions } from './NavigationStack.tsx'
export { Screen } from './Screen.tsx'
export type { ScreenProps } from './Screen.tsx'
export { TabBar, TabView, useTabBar } from './TabBar.tsx'
export type { Tab, TabApi, TabBarProps, TabItem, TabViewProps } from './TabBar.tsx'

export { Sheet, useSheet } from './Sheet.tsx'
export type { SheetProps, SheetDetent, SheetOptions, UseSheet } from './Sheet.tsx'
export { Alert, ActionSheet, useAlert } from './Alert.tsx'
export type { AlertOptions, AlertProps, ActionSheetOptions, ActionSheetProps, ConfirmOptions, DialogAction, UseAlert } from './Alert.tsx'
export { Banner, useToast } from './Toast.tsx'
export type { BannerProps, ToastOptions } from './Toast.tsx'

export { List, Section, Row } from './List.tsx'
export type { ListProps, SectionProps, RowProps } from './List.tsx'
export { TextField, TextFieldRow, SecureField, TextArea } from './Fields.tsx'
export type { TextFieldProps, TextFieldRowProps, SecureFieldProps, TextAreaProps } from './Fields.tsx'
export { Toggle } from './Toggle.tsx'
export type { ToggleProps } from './Toggle.tsx'
export { Button } from './Button.tsx'
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button.tsx'
export { SegmentedControl, MarkPicker } from './SegmentedControl.tsx'
export type { SegmentedControlProps, SegmentOption, MarkPickerProps } from './SegmentedControl.tsx'
export { CheckCircle } from './CheckCircle.tsx'
export type { CheckCircleProps } from './CheckCircle.tsx'
export { Avatar, AvatarStack, initialsFor } from './Avatar.tsx'
export type { AvatarProps, AvatarStackProps } from './Avatar.tsx'
export { ScoreRing } from './ScoreRing.tsx'
export type { ScoreRingProps } from './ScoreRing.tsx'

export { IridescentEdgeGlow, Shimmer, useEdgeGlow } from './Iridescence.tsx'
export type { EdgeGlowHandle, IridescentEdgeGlowProps, ShimmerHandle, ShimmerProps } from './Iridescence.tsx'
export { GlassSurface, GlassButton, requestMotionPermission } from './Glass.tsx'
export type { GlassSurfaceProps, GlassButtonProps } from './Glass.tsx'

export { Pill, Badge, ActivityIndicator, EmptyState, ProgressBar } from './Feedback.tsx'
export type { PillProps, PillTone, BadgeProps, ActivityIndicatorProps, EmptyStateProps, ProgressBarProps } from './Feedback.tsx'
export { Text } from './Text.tsx'
export type { TextProps, TextVariant, TextColor } from './Text.tsx'
export { Icon, iconNames } from './icons.tsx'
export type { IconName, IconProps } from './icons.tsx'

export {
  springs,
  transitionFor,
  usePrefersReducedMotion,
  usePrefersReducedTransparency,
  prefersReducedMotion,
  prefersReducedTransparency,
} from './motion.ts'
export type { SpringName, SpringPreset } from './motion.ts'
export { haptic } from './haptics.ts'
export { cx } from './press.ts'

// The shared-goal screens' seam (SPEC §11.9.5, build plan §4): what the Friends tab mounts and pushes.
//   SharedGoalsSection: the whole "Shared Goals" section of the Friends root (invitations, goals, New, Finished).
//   SharedGoalScreen: one goal, pushed by the section and by a check-in push (?goal=).
//   useNewSharedGoal(): presents New Shared Goal from the caller's sheet context and pushes the goal it creates.
export { SharedGoalsSection } from './SharedGoalsSection.tsx'
export { SharedGoalScreen } from './SharedGoalScreen.tsx'
export { useNewSharedGoal } from './NewSharedGoalSheet.tsx'

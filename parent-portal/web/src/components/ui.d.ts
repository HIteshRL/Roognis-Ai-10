/**
 * Types for the existing `ui.jsx` primitives. New TypeScript features reuse
 * these rather than re-implementing buttons, badges, modals or toasts.
 */
import type { ReactNode } from 'react'

export type BadgeTone = 'default' | 'neutral' | 'primary' | 'info' | 'success' | 'warn' | 'warning' | 'danger'
export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export declare function Icon(props: {
  name: string
  size?: number
  label?: string
}): JSX.Element

export declare function Avatar(props: {
  name?: string | null
  id?: string | null
  size?: 'sm' | 'md' | 'lg'
}): JSX.Element

export declare function Badge(props: {
  children?: ReactNode
  tone?: BadgeTone
  dot?: boolean
}): JSX.Element

export declare function StatusBadge(props: {
  tone?: StatusTone
  label?: ReactNode
  icon?: string
}): JSX.Element

export declare function Spinner(props: { size?: number }): JSX.Element

export declare function Loading(props: { label?: string }): JSX.Element

export declare function LoadingState(props: { label?: string }): JSX.Element

export declare function EmptyState(props: {
  icon?: ReactNode
  title?: ReactNode
  hint?: ReactNode
  action?: ReactNode
}): JSX.Element

export declare function PageHeader(props: {
  eyebrow?: ReactNode
  title?: ReactNode
  description?: ReactNode
  children?: ReactNode
}): JSX.Element

export declare function Surface(props: {
  as?: keyof JSX.IntrinsicElements
  className?: string
  children?: ReactNode
}): JSX.Element

export declare function Metric(props: {
  label?: ReactNode
  value?: ReactNode
  hint?: ReactNode
  tone?: string
}): JSX.Element

export declare function ActionCard(props: {
  eyebrow?: ReactNode
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
  tone?: string
  children?: ReactNode
}): JSX.Element

export declare function ListRow(props: {
  as?: keyof JSX.IntrinsicElements
  className?: string
  children?: ReactNode
  [key: string]: unknown
}): JSX.Element

export declare function ErrorNotice(props: {
  message?: ReactNode
  children?: ReactNode
}): JSX.Element | null

export declare function Modal(props: {
  open: boolean
  onClose?: () => void
  title?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  wide?: boolean
}): JSX.Element | null

export declare function Drawer(props: {
  open: boolean
  onClose?: () => void
  title?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  wide?: boolean
}): JSX.Element | null

export declare function FocusRing(props: { children?: ReactNode }): JSX.Element

export declare function MobileActionBar(props: { children?: ReactNode }): JSX.Element

export declare function ToastProvider(props: { children?: ReactNode }): JSX.Element

export interface Toast {
  show: (message: string) => void
  success: (message: string) => void
  error: (message: string) => void
}

export declare function useToast(): Toast

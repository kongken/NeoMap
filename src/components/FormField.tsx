import type { ReactNode } from 'react'
import { Label } from '@/components/ui/label'

interface Props {
  id: string
  label: string
  required?: boolean
  error?: string
  hint?: string
  children: ReactNode
}

/** 表单字段：label + 控件 + 就近显示的错误 */
export function FormField({ id, label, required, error, hint, children }: Props) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? <span className="text-destructive" aria-hidden>*</span> : <span className="text-xs font-normal text-muted-foreground">（可选）</span>}
      </Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

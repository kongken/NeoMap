import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/FormField'
import { describedBy } from '@/lib/a11y'
import { LIMITS, tripFormSchema, type TripFormInput, type TripFormValues } from '@/lib/validation'
import type { Trip } from '@/types'
import { useAppData } from '@/app/AppDataContext'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 传入则为编辑模式 */
  trip?: Trip | null
}

const toDefaults = (trip?: Trip | null): TripFormInput => ({
  title: trip?.title ?? '',
  startDate: trip?.startDate ?? '',
  endDate: trip?.endDate ?? '',
  notes: trip?.notes ?? '',
})

export function TripFormDialog({ open, onOpenChange, trip }: Props) {
  const { createTrip, updateTrip } = useAppData()
  const [submitError, setSubmitError] = useState<string | null>(null)
  const form = useForm<TripFormInput, unknown, TripFormValues>({
    resolver: zodResolver(tripFormSchema),
    defaultValues: toDefaults(trip),
  })
  const { register, handleSubmit, reset, formState } = form
  const { errors, isSubmitting } = formState

  useEffect(() => {
    if (open) {
      reset(toDefaults(trip))
      setSubmitError(null)
    }
  }, [open, trip, reset])

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null)
    try {
      if (trip) await updateTrip(trip.id, values)
      else await createTrip(values)
      toast.success(trip ? '假期已保存' : '假期已创建')
      onOpenChange(false)
    } catch (err) {
      // 保存失败：保留表单输入
      setSubmitError(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !isSubmitting && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{trip ? '编辑假期' : '新建假期'}</DialogTitle>
          <DialogDescription>记录一次旅行，然后添加航段。</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <FormField id="trip-title" label="标题" required error={errors.title?.message}>
            <Input id="trip-title" maxLength={LIMITS.title + 20} placeholder="例如：2026 国庆亚洲之旅" aria-invalid={!!errors.title} aria-describedby={describedBy('trip-title', errors.title?.message)} {...register('title')} autoFocus />
          </FormField>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField id="trip-start" label="开始日期" error={errors.startDate?.message}>
              <Input id="trip-start" type="date" aria-invalid={!!errors.startDate} aria-describedby={describedBy('trip-start', errors.startDate?.message)} {...register('startDate')} />
            </FormField>
            <FormField id="trip-end" label="结束日期" error={errors.endDate?.message}>
              <Input id="trip-end" type="date" aria-invalid={!!errors.endDate} aria-describedby={describedBy('trip-end', errors.endDate?.message)} {...register('endDate')} />
            </FormField>
          </div>
          <FormField id="trip-notes" label="备注" error={errors.notes?.message} hint={`最多 ${LIMITS.notes} 字`}>
            <Textarea id="trip-notes" rows={3} aria-invalid={!!errors.notes} aria-describedby={describedBy('trip-notes', errors.notes?.message, 'x')} {...register('notes')} />
          </FormField>
          {submitError && (
            <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive" role="alert">
              {submitError}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              取消
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="animate-spin" aria-hidden />}
              {trip ? '保存' : '创建假期'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

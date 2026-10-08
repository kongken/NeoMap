import { useEffect, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Info, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/FormField'
import { describedBy } from '@/lib/a11y'
import { legFormSchema, LIMITS } from '@/lib/validation'
import type { Airport, FlightLeg } from '@/types'
import { useAppData } from '@/app/AppDataContext'
import { AirportCombobox } from './AirportCombobox'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 编辑模式 */
  leg?: FlightLeg | null
}

interface FormValues {
  departure: Airport | null
  arrival: Airport | null
  departureDate: string
  flightNumber?: string
  airline?: string
  notes?: string
}

export function LegFormDialog({ open, onOpenChange, leg }: Props) {
  const { bundle, airportsById, addLeg, updateLeg } = useAppData()
  const [submitError, setSubmitError] = useState<string | null>(null)
  const form = useForm<FormValues>({
    // 表单值包含完整机场对象，schema 只校验必要字段
    resolver: zodResolver(legFormSchema) as never,
    defaultValues: { departure: null, arrival: null, departureDate: '', flightNumber: '', airline: '', notes: '' },
  })
  const { register, handleSubmit, reset, control, formState, watch } = form
  const { errors, isSubmitting } = formState

  const lastLeg = bundle?.legs.at(-1)

  useEffect(() => {
    if (!open) return
    setSubmitError(null)
    if (leg) {
      reset({
        departure: airportsById.get(leg.departureAirportId) ?? null,
        arrival: airportsById.get(leg.arrivalAirportId) ?? null,
        departureDate: leg.departureDate,
        flightNumber: leg.flightNumber ?? '',
        airline: leg.airline ?? '',
        notes: leg.notes ?? '',
      })
    } else {
      // 新航段：出发机场预填上一段到达机场，日期预填上一段日期或假期开始日期
      reset({
        departure: lastLeg ? (airportsById.get(lastLeg.arrivalAirportId) ?? null) : null,
        arrival: null,
        departureDate: lastLeg?.departureDate ?? bundle?.trip.startDate ?? '',
        flightNumber: '',
        airline: '',
        notes: '',
      })
    }
    // 仅在打开时初始化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, leg])

  const departure = watch('departure')
  const showGapHint = !leg && lastLeg && departure && airportsById.get(lastLeg.arrivalAirportId)?.iata !== departure.iata

  const onSubmit = handleSubmit(async (v) => {
    setSubmitError(null)
    if (!v.departure || !v.arrival) return
    const input = {
      departure: v.departure,
      arrival: v.arrival,
      departureDate: v.departureDate,
      flightNumber: v.flightNumber,
      airline: v.airline,
      notes: v.notes,
    }
    try {
      if (leg) await updateLeg(leg.id, input)
      else await addLeg(input)
      toast.success('已保存')
      onOpenChange(false)
    } catch (err) {
      setSubmitError(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !isSubmitting && onOpenChange(o)}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{leg ? '编辑航段' : '添加航段'}</DialogTitle>
          <DialogDescription>只记录出发当地日期，不记录起降时间。</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <FormField id="leg-departure" label="出发机场" required error={errors.departure?.message}>
            <Controller
              control={control}
              name="departure"
              render={({ field }) => <AirportCombobox id="leg-departure" value={field.value} onChange={field.onChange} invalid={!!errors.departure} describedBy={describedBy('leg-departure', errors.departure?.message)} />}
            />
          </FormField>
          <FormField id="leg-arrival" label="到达机场" required error={errors.arrival?.message}>
            <Controller
              control={control}
              name="arrival"
              render={({ field }) => <AirportCombobox id="leg-arrival" value={field.value} onChange={field.onChange} invalid={!!errors.arrival} describedBy={describedBy('leg-arrival', errors.arrival?.message)} />}
            />
          </FormField>
          {showGapHint && (
            <p className="flex gap-2 rounded-md bg-sky-50 p-2 text-sm text-sky-900">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              出发机场与上一段到达机场不同。可以保存；地图不会自动补画中间的交通。
            </p>
          )}
          <FormField id="leg-date" label="出发日期（当地）" required error={errors.departureDate?.message}>
            <Input id="leg-date" type="date" aria-invalid={!!errors.departureDate} aria-describedby={describedBy('leg-date', errors.departureDate?.message)} {...register('departureDate')} />
          </FormField>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField id="leg-flight" label="航班号" error={errors.flightNumber?.message}>
              <Input id="leg-flight" placeholder="例如 KE 123" maxLength={LIMITS.flightNumber + 8} aria-invalid={!!errors.flightNumber} aria-describedby={describedBy('leg-flight', errors.flightNumber?.message)} {...register('flightNumber')} />
            </FormField>
            <FormField id="leg-airline" label="航空公司" error={errors.airline?.message}>
              <Input id="leg-airline" maxLength={LIMITS.airline + 20} aria-invalid={!!errors.airline} aria-describedby={describedBy('leg-airline', errors.airline?.message)} {...register('airline')} />
            </FormField>
          </div>
          <FormField id="leg-notes" label="备注" error={errors.notes?.message}>
            <Textarea id="leg-notes" rows={2} aria-invalid={!!errors.notes} aria-describedby={describedBy('leg-notes', errors.notes?.message)} {...register('notes')} />
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
              {leg ? '保存航段' : '添加航段'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

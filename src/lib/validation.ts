import { z } from 'zod'

/** 校验 YYYY-MM-DD 是否为真实日历日期（不经过时区转换） */
export function isValidIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1) return false
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  return d <= daysInMonth
}

export const isoDate = z.string().refine(isValidIsoDate, { message: '日期格式应为 YYYY-MM-DD 且为有效日期' })

export const LIMITS = {
  title: 80,
  notes: 1000,
  flightNumber: 12,
  airline: 60,
} as const

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label}最多 ${max} 字`)
    .optional()
    .transform((v) => (v ? v : undefined))

const optionalDate = z
  .string()
  .trim()
  .optional()
  .refine((v) => !v || isValidIsoDate(v), { message: '请输入有效日期' })
  .transform((v) => (v ? v : undefined))

export const tripFormSchema = z
  .object({
    title: z.string().trim().min(1, '请填写标题').max(LIMITS.title, `标题最多 ${LIMITS.title} 字`),
    startDate: optionalDate,
    endDate: optionalDate,
    notes: optionalText(LIMITS.notes, '备注'),
  })
  .refine((v) => !v.startDate || !v.endDate || v.endDate >= v.startDate, {
    message: '结束日期不能早于开始日期',
    path: ['endDate'],
  })

export type TripFormInput = z.input<typeof tripFormSchema>
export type TripFormValues = z.output<typeof tripFormSchema>

const airportRef = z
  .object({ id: z.string(), iata: z.string() })
  .passthrough()
  .nullable()

export const legFormSchema = z
  .object({
    departure: airportRef.refine((v) => v !== null, '请选择出发机场'),
    arrival: airportRef.refine((v) => v !== null, '请选择到达机场'),
    departureDate: z.string().trim().min(1, '请选择出发日期').refine(isValidIsoDate, '请输入有效日期'),
    flightNumber: optionalText(LIMITS.flightNumber, '航班号'),
    airline: optionalText(LIMITS.airline, '航空公司'),
    notes: optionalText(LIMITS.notes, '备注'),
  })
  .refine((v) => !v.departure || !v.arrival || v.departure.iata !== v.arrival.iata, {
    message: '出发和到达机场不能相同',
    path: ['arrival'],
  })

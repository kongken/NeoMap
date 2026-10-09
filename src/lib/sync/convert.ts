import { create } from '@bufbuild/protobuf'
import { timestampDate, timestampFromDate, type Timestamp } from '@bufbuild/protobuf/wkt'
import {
  AirportSchema,
  FlightLegSchema,
  TripBundleSchema,
  TripSchema,
  type TripBundle as ProtoBundle,
} from '@/gen/neomap/v1/trip_pb'
import type { FlightLeg, ReferencedAirport, Trip } from '@/types'

/** 本地的完整行程（与 TripRepository.getBundle 返回结构一致） */
export interface LocalBundle {
  trip: Trip
  legs: FlightLeg[]
  airports: ReferencedAirport[]
}

const ts = (iso: string): Timestamp => timestampFromDate(new Date(iso))
const iso = (t: Timestamp | undefined): string => (t ? timestampDate(t).toISOString() : new Date(0).toISOString())
const opt = (s: string): string | undefined => (s === '' ? undefined : s)

/** 本地行程 → proto（用于 PutTrip） */
export function toProto(b: LocalBundle): ProtoBundle {
  const legs = [...b.legs].sort((x, y) => x.order - y.order)
  return create(TripBundleSchema, {
    trip: create(TripSchema, {
      id: b.trip.id,
      title: b.trip.title,
      startDate: b.trip.startDate ?? '',
      endDate: b.trip.endDate ?? '',
      notes: b.trip.notes ?? '',
      isSample: b.trip.isSample ?? false,
      createdAt: ts(b.trip.createdAt),
      updatedAt: ts(b.trip.updatedAt),
    }),
    legs: legs.map((l, i) =>
      create(FlightLegSchema, {
        id: l.id,
        order: i,
        departureAirportId: l.departureAirportId,
        arrivalAirportId: l.arrivalAirportId,
        departureDate: l.departureDate,
        flightNumber: l.flightNumber ?? '',
        airline: l.airline ?? '',
        notes: l.notes ?? '',
        createdAt: ts(l.createdAt),
        updatedAt: ts(l.updatedAt),
      }),
    ),
    airports: [...b.airports]
      .sort((x, y) => x.id.localeCompare(y.id))
      .map((a) =>
        create(AirportSchema, {
          id: a.id,
          iata: a.iata,
          name: a.name,
          nameZh: a.nameZh ?? '',
          city: a.city ?? '',
          cityZh: a.cityZh ?? '',
          aliases: a.aliases ?? [],
          countryCode: a.countryCode,
          countryName: a.countryName ?? '',
          latitude: a.latitude,
          longitude: a.longitude,
        }),
      ),
  })
}

/** proto → 本地行程（用于应用服务端版本）。墓碑不应调用此函数。 */
export function fromProto(p: ProtoBundle): LocalBundle {
  const t = p.trip!
  const trip: Trip = { id: t.id, title: t.title, createdAt: iso(t.createdAt), updatedAt: iso(t.updatedAt) }
  if (t.startDate) trip.startDate = t.startDate
  if (t.endDate) trip.endDate = t.endDate
  if (t.notes) trip.notes = t.notes
  if (t.isSample) trip.isSample = true
  return {
    trip,
    legs: [...p.legs]
      .sort((x, y) => x.order - y.order)
      .map((l) => {
        const leg: FlightLeg = {
          id: l.id,
          tripId: t.id,
          departureAirportId: l.departureAirportId,
          arrivalAirportId: l.arrivalAirportId,
          departureDate: l.departureDate,
          order: l.order,
          createdAt: iso(l.createdAt),
          updatedAt: iso(l.updatedAt),
        }
        if (opt(l.flightNumber)) leg.flightNumber = l.flightNumber
        if (opt(l.airline)) leg.airline = l.airline
        if (opt(l.notes)) leg.notes = l.notes
        return leg
      }),
    airports: p.airports.map((a) => {
      const ap: ReferencedAirport = {
        key: `${t.id}:${a.id}`,
        tripId: t.id,
        id: a.id,
        iata: a.iata,
        name: a.name,
        countryCode: a.countryCode,
        latitude: a.latitude,
        longitude: a.longitude,
      }
      if (a.nameZh) ap.nameZh = a.nameZh
      if (a.city) ap.city = a.city
      if (a.cityZh) ap.cityZh = a.cityZh
      if (a.aliases.length) ap.aliases = [...a.aliases]
      if (a.countryName) ap.countryName = a.countryName
      return ap
    }),
  }
}

/** 规范化后的内容指纹（忽略版本号、顺序与可选字段的空值差异） */
function fingerprint(b: LocalBundle): string {
  const p = toProto(b)
  const t = p.trip!
  return JSON.stringify({
    t: [t.id, t.title, t.startDate, t.endDate, t.notes, t.isSample, iso(t.createdAt), iso(t.updatedAt)],
    l: p.legs.map((l) => [l.id, l.order, l.departureAirportId, l.arrivalAirportId, l.departureDate, l.flightNumber, l.airline, l.notes, iso(l.createdAt), iso(l.updatedAt)]),
    a: p.airports.map((a) => [a.id, a.iata, a.name, a.nameZh, a.city, a.cityZh, a.aliases, a.countryCode, a.countryName, a.latitude, a.longitude]),
  })
}

/** 两个行程内容是否相同：相同时「冲突」其实无需另存副本 */
export function sameContent(a: LocalBundle, b: LocalBundle): boolean {
  return fingerprint(a) === fingerprint(b)
}

/** 冲突副本的标题：保持在 80 字以内 */
export function copyTitle(title: string): string {
  const suffix = '（本设备副本）'
  return title.length + suffix.length > 80 ? `${title.slice(0, 80 - suffix.length)}${suffix}` : `${title}${suffix}`
}

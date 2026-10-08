import Dexie, { type EntityTable } from 'dexie'
import type { FlightLeg, ReferencedAirport, Trip } from '@/types'

export class HolidayDb extends Dexie {
  trips!: EntityTable<Trip, 'id'>
  legs!: EntityTable<FlightLeg, 'id'>
  referencedAirports!: EntityTable<ReferencedAirport, 'key'>

  constructor(name = 'holiday-flight-map') {
    super(name)
    this.version(1).stores({
      trips: 'id, createdAt',
      legs: 'id, tripId, [tripId+order]',
      referencedAirports: 'key, tripId',
    })
  }
}

let instance: HolidayDb | null = null

export function getDb(): HolidayDb {
  if (!instance) instance = new HolidayDb()
  return instance
}

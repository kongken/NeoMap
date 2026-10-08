export interface Airport {
  /** 稳定数据源标识，例如 oa:26674（OurAirports id）；导入的快照为 import:<uuid> */
  id: string
  iata: string
  name: string
  nameZh?: string
  city?: string
  cityZh?: string
  aliases?: string[]
  countryCode: string
  countryName?: string
  latitude: number
  longitude: number
}

export interface Trip {
  id: string
  title: string
  startDate?: string
  endDate?: string
  notes?: string
  /** 由示例入口创建时为 true，用于标识「示例」 */
  isSample?: boolean
  createdAt: string
  updatedAt: string
}

export interface FlightLeg {
  id: string
  tripId: string
  departureAirportId: string
  arrivalAirportId: string
  /** 出发地当地日期 YYYY-MM-DD */
  departureDate: string
  flightNumber?: string
  airline?: string
  notes?: string
  order: number
  createdAt: string
  updatedAt: string
}

/** 持久化的机场快照，按「行程 + 机场」隔离，静态目录更新不影响旧行程 */
export interface ReferencedAirport extends Airport {
  /** 本地主键：<tripId>:<airport.id> */
  key: string
  tripId: string
}

export interface BackupV1 {
  schemaVersion: 1
  app: 'holiday-flight-map'
  exportedAt: string
  trips: Trip[]
  legs: FlightLeg[]
  airports: Airport[]
}

export type LngLat = [number, number]

import type { Client } from '@connectrpc/connect'
import type { TripService } from '@/gen/neomap/v1/trip_pb'
import type { TripApi } from './engine'

/** 基于 TripService 客户端的 TripApi 实现 */
export function createTripApi(client: Client<typeof TripService>): TripApi {
  return {
    async listChanges(cursor, pageSize) {
      const res = await client.listChanges({ cursor, pageSize })
      return { trips: res.trips, nextCursor: res.nextCursor, hasMore: res.hasMore }
    },
    async putTrip(bundle, baseRevision) {
      const res = await client.putTrip({ bundle, baseRevision: BigInt(baseRevision) })
      if (!res.bundle) throw new Error('服务端未返回行程')
      return res.bundle
    },
    async deleteTrip(tripId, baseRevision) {
      const res = await client.deleteTrip({ tripId, baseRevision: BigInt(baseRevision) })
      return Number(res.revision)
    },
  }
}

import { createClient, type Client } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-web'
import { AuthService } from '@/gen/neomap/v1/auth_pb'
import { SystemService } from '@/gen/neomap/v1/system_pb'
import { TripService } from '@/gen/neomap/v1/trip_pb'

/**
 * 后端 API 客户端（ConnectRPC）。
 *
 * VITE_API_BASE_URL 为空时表示未接入后端：应用保持纯本地模式，不发起任何请求。
 * 请求携带 Cookie（credentials: 'include'），用于后续的登录会话。
 */
export const apiBaseUrl: string | null = import.meta.env.VITE_API_BASE_URL?.trim() || null

const transport = apiBaseUrl
  ? createConnectTransport({
      baseUrl: apiBaseUrl,
      fetch: (input, init) => fetch(input, { ...init, credentials: 'include' }),
    })
  : null

export const systemClient: Client<typeof SystemService> | null = transport ? createClient(SystemService, transport) : null
export const authClient: Client<typeof AuthService> | null = transport ? createClient(AuthService, transport) : null
export const tripClient: Client<typeof TripService> | null = transport ? createClient(TripService, transport) : null

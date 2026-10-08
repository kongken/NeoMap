import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { Provider, User } from '@/gen/neomap/v1/auth_pb'
import { apiBaseUrl, authClient } from '@/lib/api/client'
import { buildLoginUrl, readLoginResult } from './loginUrl'

export type AuthState =
  /** 未配置后端：纯本地模式，不显示任何账号入口 */
  | { status: 'disabled' }
  | { status: 'loading' }
  | { status: 'anonymous'; providers: Provider[] }
  | { status: 'authenticated'; user: User; providers: Provider[] }
  /** 后端不可达：本地功能照常使用 */
  | { status: 'unavailable' }

interface AuthContextValue {
  state: AuthState
  login: (provider: string) => void
  logout: (allDevices?: boolean) => Promise<void>
  refresh: () => Promise<void>
}

const Ctx = createContext<AuthContextValue | null>(null)

/** 读取当前登录状态与可用登录方式；后端不可达时返回 unavailable，不抛错。 */
async function loadAuthState(): Promise<AuthState> {
  if (!authClient) return { status: 'disabled' }
  try {
    const [me, providers] = await Promise.all([authClient.getMe({}), authClient.listProviders({})])
    return me.user ? { status: 'authenticated', user: me.user, providers: providers.providers } : { status: 'anonymous', providers: providers.providers }
  } catch {
    return { status: 'unavailable' }
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(authClient ? { status: 'loading' } : { status: 'disabled' })
  const handledLoginResult = useRef(false)

  const refresh = useCallback(async () => {
    setState(await loadAuthState())
  }, [])

  useEffect(() => {
    let cancelled = false
    loadAuthState().then((s) => {
      if (!cancelled) setState(s)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // 处理 OAuth 回跳附带的 login / login_error 参数（只处理一次，并从地址栏移除）
  useEffect(() => {
    if (handledLoginResult.current) return
    handledLoginResult.current = true
    const { result, cleanedUrl } = readLoginResult(window.location.href)
    if (cleanedUrl !== null) window.history.replaceState(window.history.state, '', cleanedUrl)
    if (result?.kind === 'error') toast.error(result.message)
    if (result?.kind === 'success') toast.success('已登录')
  }, [])

  const login = useCallback((provider: string) => {
    if (!apiBaseUrl) return
    window.location.assign(buildLoginUrl(apiBaseUrl, provider, window.location))
  }, [])

  const logout = useCallback(
    async (allDevices = false) => {
      if (!authClient) return
      await authClient.logout({ allDevices })
      await refresh()
      toast.success(allDevices ? '已退出所有设备' : '已退出登录')
    },
    [refresh],
  )

  return <Ctx.Provider value={{ state, login, logout, refresh }}>{children}</Ctx.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth must be used within AuthProvider')
  return v
}

/** 登录跳转地址与登录结果参数的处理（纯函数，便于测试）。 */

/** 后端 OAuth 登录入口：{api}/auth/oauth/{provider}/start?return_to=当前页面 */
export function buildLoginUrl(apiBaseUrl: string, provider: string, location: Pick<Location, 'pathname' | 'search' | 'hash'>): string {
  const params = new URLSearchParams(location.search)
  params.delete('login')
  params.delete('login_error')
  const search = params.toString()
  const returnTo = `${location.pathname}${search ? `?${search}` : ''}${location.hash}`
  return `${apiBaseUrl.replace(/\/+$/, '')}/auth/oauth/${encodeURIComponent(provider)}/start?return_to=${encodeURIComponent(returnTo)}`
}

export type LoginResult = { kind: 'success' } | { kind: 'error'; message: string } | null

const ERROR_MESSAGES: Record<string, string> = {
  cancelled: '已取消登录',
  invalid_state: '登录已过期或无效，请重新登录',
  rate_limited: '登录尝试过于频繁，请稍后再试',
  unknown_provider: '不支持该登录方式',
  failed: '登录失败，请稍后重试',
}

/**
 * 读取后端回跳时附加的 login / login_error 参数。
 * 返回结果与去掉这两个参数后的地址（用于 history.replaceState，避免刷新时重复提示）。
 */
export function readLoginResult(href: string): { result: LoginResult; cleanedUrl: string | null } {
  const url = new URL(href)
  const ok = url.searchParams.get('login')
  const err = url.searchParams.get('login_error')
  if (ok === null && err === null) return { result: null, cleanedUrl: null }
  url.searchParams.delete('login')
  url.searchParams.delete('login_error')
  const cleanedUrl = `${url.pathname}${url.search}${url.hash}`
  if (err !== null) return { result: { kind: 'error', message: ERROR_MESSAGES[err] ?? ERROR_MESSAGES.failed }, cleanedUrl }
  return { result: ok === 'success' ? { kind: 'success' } : null, cleanedUrl }
}

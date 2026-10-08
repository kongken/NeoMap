import { useState } from 'react'
import { CloudOff, Loader2, LogIn, LogOut, MonitorSmartphone, RefreshCw, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuth } from './AuthContext'

const providerLabel = (name: string) => (name === 'github' ? 'GitHub' : name === 'google' ? 'Google' : name)

function Avatar({ name, url }: { name: string; url: string }) {
  const [broken, setBroken] = useState(false)
  if (url && !broken) {
    return <img src={url} alt="" className="size-6 rounded-full object-cover" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
  }
  return (
    <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary" aria-hidden>
      {name.trim().slice(0, 1).toUpperCase() || <UserRound className="size-3.5" />}
    </span>
  )
}

/** 顶栏账号入口。未配置后端（纯本地模式）时不渲染。 */
export function AccountMenu({ compact = false }: { compact?: boolean }) {
  const { state, login, logout, refresh } = useAuth()
  const [busy, setBusy] = useState(false)

  if (state.status === 'disabled') return null

  if (state.status === 'loading') {
    return (
      <Button variant="ghost" size={compact ? 'icon' : 'default'} disabled aria-label="正在检查登录状态">
        <Loader2 className="animate-spin" aria-hidden />
        {!compact && '登录'}
      </Button>
    )
  }

  const run = async (fn: () => Promise<void>, failMessage: string) => {
    setBusy(true)
    try {
      await fn()
    } catch {
      toast.error(failMessage)
    } finally {
      setBusy(false)
    }
  }

  if (state.status === 'unavailable') {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size={compact ? 'icon' : 'default'} aria-label="账号服务暂不可用">
            <CloudOff aria-hidden />
            {!compact && '离线'}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">暂时无法连接账号服务。行程仍保存在当前浏览器，可正常使用。</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void run(refresh, '仍无法连接，请稍后再试')}>
            <RefreshCw aria-hidden />
            重试连接
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  if (state.status === 'anonymous') {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size={compact ? 'icon' : 'default'} aria-label="登录">
            <LogIn aria-hidden />
            {!compact && '登录'}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">登录后可在多台设备间同步行程（同步功能开发中）</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {state.providers.length === 0 ? (
            <DropdownMenuItem disabled>暂未开放登录</DropdownMenuItem>
          ) : (
            state.providers.map((p) => (
              <DropdownMenuItem key={p.name} onSelect={() => login(p.name)}>
                <LogIn aria-hidden />
                使用 {p.displayName || providerLabel(p.name)} 登录
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  const { user } = state
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size={compact ? 'icon' : 'default'} aria-label={`账号：${user.displayName}`} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Avatar name={user.displayName} url={user.avatarUrl} />}
          {!compact && <span className="max-w-32 truncate">{user.displayName}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="space-y-0.5">
          <span className="block truncate">{user.displayName}</span>
          {user.email && <span className="block truncate text-xs font-normal text-muted-foreground">{user.email}</span>}
          <span className="block text-xs font-normal text-muted-foreground">通过 {providerLabel(user.provider)} 登录</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">云同步开发中，行程目前仍只保存在当前浏览器。</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void run(() => logout(false), '退出登录失败，请重试')}>
          <LogOut aria-hidden />
          退出登录
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run(() => logout(true), '退出失败，请重试')}>
          <MonitorSmartphone aria-hidden />
          退出所有设备
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

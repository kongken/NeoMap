import { useState } from 'react'
import { cn } from '@/lib/utils'
import { CircleAlert, CloudCheck, CloudOff, CloudUpload, Loader2, LogIn, LogOut, MonitorSmartphone, RefreshCw, UserRound } from 'lucide-react'
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
import { useSync, type PendingCounts, type SyncStatus } from '@/features/sync/SyncContext'

function relativeTime(iso?: string): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/** 同步状态的文字描述与图标 */
function describeSync(status: SyncStatus, counts: PendingCounts): { text: string; icon: typeof CloudCheck; tone: 'ok' | 'busy' | 'warn' } {
  const pending = counts.dirty + counts.deletes
  if (status.kind === 'syncing') return { text: '正在同步…', icon: RefreshCw, tone: 'busy' }
  if (status.kind === 'awaiting-decision') return { text: '等待选择如何处理本设备上的数据', icon: CircleAlert, tone: 'warn' }
  if (status.kind === 'offline') return { text: `暂时无法连接，恢复后自动同步${pending ? `（${pending} 项待同步）` : ''}`, icon: CloudOff, tone: 'warn' }
  if (counts.errors > 0) return { text: `${counts.errors} 个假期同步失败，修改后会重试`, icon: CircleAlert, tone: 'warn' }
  if (pending > 0) return { text: `${pending} 项待同步`, icon: CloudUpload, tone: 'busy' }
  const when = status.kind === 'idle' ? relativeTime(status.lastSyncedAt) : ''
  return { text: `已同步${when ? ` · ${when}` : ''}`, icon: CloudCheck, tone: 'ok' }
}

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
  const { state, login, refresh } = useAuth()
  const sync = useSync()
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
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            {sync.status.kind === 'signed-out' && sync.counts.dirty + sync.counts.deletes > 0
              ? `本设备有 ${sync.counts.dirty + sync.counts.deletes} 项修改尚未同步到「${sync.account?.displayName ?? '账号'}」，登录后继续同步`
              : '登录后可在多台设备间同步假期'}
          </DropdownMenuLabel>
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
  const syncInfo = describeSync(sync.status, sync.counts)
  const SyncIcon = syncInfo.icon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size={compact ? 'icon' : 'default'} aria-label={`账号：${user.displayName}，${syncInfo.text}`} disabled={busy} data-testid="account-button">
          <span className="relative">
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Avatar name={user.displayName} url={user.avatarUrl} />}
            <span
              className={cn(
                'absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-full bg-background',
                syncInfo.tone === 'ok' ? 'text-emerald-600' : syncInfo.tone === 'warn' ? 'text-amber-600' : 'text-primary',
              )}
              aria-hidden
            >
              <SyncIcon className={cn('size-3', sync.status.kind === 'syncing' && 'animate-spin')} />
            </span>
          </span>
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
        <DropdownMenuLabel className="flex items-start gap-1.5 text-xs font-normal text-muted-foreground" data-testid="sync-status">
          <SyncIcon className={cn('mt-0.5 size-3.5 shrink-0', sync.status.kind === 'syncing' && 'animate-spin')} aria-hidden />
          {syncInfo.text}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => sync.syncNow()} disabled={sync.status.kind === 'syncing' || sync.status.kind === 'awaiting-decision'}>
          <RefreshCw aria-hidden />
          立即同步
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void run(() => sync.requestLogout(false), '退出登录失败，请重试')}>
          <LogOut aria-hidden />
          退出登录
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run(() => sync.requestLogout(true), '退出失败，请重试')}>
          <MonitorSmartphone aria-hidden />
          退出所有设备
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

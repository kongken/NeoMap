import { useState } from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { useSync } from './SyncContext'

/** 账号相关的决定：首次登录是否上传、切换账号、退出登录时如何处理本设备数据 */
export function SyncDialogs() {
  const { decision, resolveFirstLogin, resolveSwitch, resolveLogout } = useSync()
  const [busy, setBusy] = useState(false)
  const [logoutChoice, setLogoutChoice] = useState<'clear' | 'keep'>('clear')

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      toast.error(`操作失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const open = decision !== null
  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        {decision?.type === 'first-login' && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>同步本设备上的假期？</AlertDialogTitle>
              <AlertDialogDescription>
                本设备上有 <strong>{decision.count}</strong> 个假期还没有保存到账号「{decision.displayName}」。上传后可以在其他设备上查看和编辑。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <p className="text-sm text-muted-foreground">选择「仅保留在本设备」的假期不会上传，之后可以在假期详情中单独上传。</p>
            <AlertDialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => run(() => resolveFirstLogin(false))}>
                仅保留在本设备
              </Button>
              <Button disabled={busy} onClick={() => run(() => resolveFirstLogin(true))}>
                {busy && <Loader2 className="animate-spin" aria-hidden />}
                上传到账号
              </Button>
            </AlertDialogFooter>
          </>
        )}

        {decision?.type === 'switch-account' && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>切换账号</AlertDialogTitle>
              <AlertDialogDescription>
                本设备上的假期属于账号「{decision.from.displayName}」。要使用「{decision.displayName}」同步，需要先处理这些数据。
              </AlertDialogDescription>
            </AlertDialogHeader>
            {decision.unsynced > 0 && (
              <p className="flex gap-2 rounded-md bg-amber-50 p-2 text-sm text-amber-900" role="alert">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                其中有 {decision.unsynced} 项修改尚未同步到「{decision.from.displayName}」，清除后将无法找回。
              </p>
            )}
            <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
              <Button variant="outline" disabled={busy} onClick={() => run(() => resolveSwitch('cancel'))}>
                取消并退出登录
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => run(() => resolveSwitch('keep'))}>
                保留为本地数据
              </Button>
              <Button variant="destructive" disabled={busy} onClick={() => run(() => resolveSwitch('clear'))}>
                清除后继续
              </Button>
            </AlertDialogFooter>
          </>
        )}

        {decision?.type === 'logout' && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{decision.allDevices ? '退出所有设备' : '退出登录'}</AlertDialogTitle>
              <AlertDialogDescription>
                本设备上有 <strong>{decision.tripCount}</strong> 个假期属于账号「{decision.account.displayName}」。退出后如何处理？
              </AlertDialogDescription>
            </AlertDialogHeader>
            {decision.unsynced > 0 && (
              <p className="flex gap-2 rounded-md bg-amber-50 p-2 text-sm text-amber-900" role="alert">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                有 {decision.unsynced} 项修改尚未同步，退出后不会再上传到账号。
              </p>
            )}
            <fieldset className="space-y-2 text-sm">
              <legend className="sr-only">本设备上的数据</legend>
              {(
                [
                  ['clear', '从本设备清除这些假期', '推荐用于共用设备；账号中的数据不受影响'],
                  ['keep', '保留在本设备', '作为未登录的本地数据继续使用'],
                ] as const
              ).map(([value, label, hint]) => (
                <label key={value} className="flex cursor-pointer gap-2 rounded-lg border p-2.5 has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                  <input type="radio" name="logout-data" value={value} checked={logoutChoice === value} onChange={() => setLogoutChoice(value)} className="mt-0.5 accent-primary" />
                  <span>
                    <span className="block font-medium">{label}</span>
                    <span className="block text-xs text-muted-foreground">{hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <AlertDialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => run(() => resolveLogout('cancel'))}>
                取消
              </Button>
              <Button disabled={busy} onClick={() => run(() => resolveLogout(logoutChoice))}>
                {busy && <Loader2 className="animate-spin" aria-hidden />}
                {decision.allDevices ? '退出所有设备' : '退出登录'}
              </Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}

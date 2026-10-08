import { useState } from 'react'
import { Loader2, Map as MapIcon, Plane, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useAppData } from '@/app/AppDataContext'

/** 首次进入：没有任何假期 */
export function EmptyState({ onCreate }: { onCreate: () => void }) {
  const { loadSample } = useAppData()
  const [loading, setLoading] = useState(false)
  return (
    <div className="space-y-4 py-4 text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10">
        <Plane className="size-6 text-primary" aria-hidden />
      </div>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">记录你的假日航线</h1>
        <p className="text-sm text-muted-foreground">创建一个假期，添加航段，在地图上回放旅程并导出海报。</p>
      </div>
      <div className="flex flex-col gap-2">
        <Button onClick={onCreate}>
          <Plus aria-hidden />
          新建假期
        </Button>
        <Button
          variant="outline"
          disabled={loading}
          onClick={async () => {
            setLoading(true)
            try {
              await loadSample()
              toast.success('已加载示例行程')
            } catch (err) {
              toast.error(`加载示例失败：${err instanceof Error ? err.message : String(err)}`)
            } finally {
              setLoading(false)
            }
          }}
        >
          {loading ? <Loader2 className="animate-spin" aria-hidden /> : <MapIcon aria-hidden />}
          加载示例行程
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">示例为「亚洲假期示例」，仅用于演示，可随时删除。</p>
    </div>
  )
}

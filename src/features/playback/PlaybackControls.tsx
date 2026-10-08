import { Pause, Play, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'
import { SPEEDS, type Speed } from '@/lib/playback/timeline'
import type { Playback } from './usePlayback'

interface Props {
  playback: Playback
  /** 当前播放到的航段编号（1 起）与总数 */
  label: string | null
}

const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`

export function PlaybackControls({ playback: p, label }: Props) {
  const playing = p.status === 'playing'
  const fraction = p.totalMs > 0 ? p.elapsedMs / p.totalMs : 0
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" aria-label="航线回放" role="group">
      <div className="flex items-center gap-1">
        <Button
          size="icon-lg"
          onClick={playing ? p.pause : p.play}
          disabled={!p.canPlay}
          aria-label={playing ? '暂停' : p.status === 'ended' ? '重新播放' : p.status === 'paused' ? '继续播放' : '播放'}
          data-testid="play-toggle"
        >
          {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
        </Button>
        <Button size="icon-lg" variant="outline" onClick={p.restart} disabled={!p.canPlay} aria-label="从头开始">
          <RotateCcw aria-hidden />
        </Button>
      </div>
      <div className="flex min-w-[10rem] flex-1 flex-col gap-1">
        <Slider
          value={[fraction * 1000]}
          min={0}
          max={1000}
          step={1}
          disabled={!p.canPlay}
          onValueChange={([v]) => p.seekFraction(v / 1000)}
          thumbLabel="回放进度"
          thumbValueText={`${fmt(p.elapsedMs)} / ${fmt(p.totalMs)}`}
          data-testid="progress"
        />
        <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>{label ?? (p.canPlay ? '未开始' : '添加航段后可回放')}</span>
          <span>
            {fmt(p.elapsedMs)} / {fmt(p.totalMs)}
          </span>
        </div>
      </div>
      <div className="flex items-center rounded-lg border p-0.5" role="radiogroup" aria-label="播放速度">
        {SPEEDS.map((s: Speed) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={p.speed === s}
            className={cn('h-7 rounded-md px-2 text-xs font-medium tabular-nums transition-colors', p.speed === s ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
            onClick={() => p.setSpeed(s)}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  )
}

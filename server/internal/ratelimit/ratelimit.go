// Package ratelimit 提供基于 Redis 的固定窗口限流，多副本共享计数。
package ratelimit

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

type Limiter struct{ rdb redis.Cmdable }

func New(rdb redis.Cmdable) *Limiter { return &Limiter{rdb: rdb} }

// Allow 在窗口内对 key 计数，未超过 limit 时返回 true。
func (l *Limiter) Allow(ctx context.Context, key string, limit int, window time.Duration) (bool, error) {
	k := "neomap:ratelimit:" + key
	var incr *redis.IntCmd
	_, err := l.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		incr = p.Incr(ctx, k)
		// NX：只在第一次计数时设置过期，窗口不随后续请求顺延
		p.ExpireNX(ctx, k, window)
		return nil
	})
	if err != nil {
		return false, err
	}
	return incr.Val() <= int64(limit), nil
}

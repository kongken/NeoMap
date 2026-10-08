// Package health 提供存活与就绪检查。
package health

import (
	"context"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// Checker 检查一个依赖是否可用。
type Checker func(ctx context.Context) error

// Handler 汇总多个依赖的检查结果。
type Handler struct {
	checks  map[string]Checker
	timeout time.Duration
}

func NewHandler(checks map[string]Checker, timeout time.Duration) *Handler {
	return &Handler{checks: checks, timeout: timeout}
}

type Result struct {
	Status string            `json:"status"`
	Checks map[string]string `json:"checks"`
}

// Check 并发执行所有检查；任一失败则整体为 unavailable。
func (h *Handler) Check(ctx context.Context) Result {
	ctx, cancel := context.WithTimeout(ctx, h.timeout)
	defer cancel()

	names := make([]string, 0, len(h.checks))
	for name := range h.checks {
		names = append(names, name)
	}
	sort.Strings(names)

	results := make([]string, len(names))
	var wg sync.WaitGroup
	for i, name := range names {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := h.checks[name](ctx); err != nil {
				// 只返回概括信息，不把连接串等细节暴露给调用方
				results[i] = "unavailable"
				return
			}
			results[i] = "ok"
		}()
	}
	wg.Wait()

	res := Result{Status: "ok", Checks: make(map[string]string, len(names))}
	for i, name := range names {
		res.Checks[name] = results[i]
		if results[i] != "ok" {
			res.Status = "unavailable"
		}
	}
	return res
}

// Ready 用于 k8s readiness probe：依赖不可用时返回 503。
func (h *Handler) Ready(c *gin.Context) {
	res := h.Check(c.Request.Context())
	code := http.StatusOK
	if res.Status != "ok" {
		code = http.StatusServiceUnavailable
	}
	c.JSON(code, res)
}

// Live 用于 k8s liveness probe：只表示进程能响应，不检查依赖，
// 避免数据库抖动时 k8s 反复重启所有副本。
func Live(service string) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"service": service, "message": "pong"})
	}
}

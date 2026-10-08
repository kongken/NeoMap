// Package app 负责装配 HTTP 路由与 ConnectRPC 服务。
package app

import (
	"net/http"
	"strings"

	connectcors "connectrpc.com/cors"
	"github.com/gin-gonic/gin"
	"github.com/rs/cors"

	"github.com/kongken/NeoMap/server/gen/neomap/v1/neomapv1connect"
	"github.com/kongken/NeoMap/server/internal/application"
	"github.com/kongken/NeoMap/server/internal/auth"
	"github.com/kongken/NeoMap/server/internal/health"
	"github.com/kongken/NeoMap/server/internal/repo/user"
)

// Deps 是路由需要的运行时依赖。它们在 Butterfly 的 InitFunc 中初始化，
// 而 Router 在 InitFunc 之后才被调用，因此这里拿到的都是已就绪的依赖。
type Deps struct {
	Build          application.BuildInfo
	Health         *health.Handler
	AllowedOrigins []string
	TrustedProxies []string
	Auth           *auth.Service
	Users          user.Repository
}

// Register 挂载所有路由。
func Register(r *gin.Engine, d *Deps) error {
	// 只采信可信代理传来的 X-Forwarded-For（gin 默认信任所有代理，会被伪造）
	if err := r.SetTrustedProxies(d.TrustedProxies); err != nil {
		return err
	}
	r.Use(corsMiddleware(d.AllowedOrigins), d.Auth.RequireAllowedOrigin(), d.Auth.Middleware())

	r.GET("/ping", health.Live(d.Build.Service))
	r.GET("/healthz", d.Health.Ready)

	r.GET("/auth/oauth/:provider/start", d.Auth.Start)
	r.GET("/auth/oauth/:provider/callback", d.Auth.Callback)

	mount := connectMounter(r)
	mount(neomapv1connect.NewSystemServiceHandler(application.NewSystemService(d.Build)))
	mount(neomapv1connect.NewAuthServiceHandler(application.NewAuthService(d.Auth, d.Users)))
	return nil
}

// connectMounter 返回把 ConnectRPC handler 挂到 gin 上的函数（路径形如 /neomap.v1.SystemService/），
// 可直接接收 NewXxxServiceHandler 的两个返回值。
func connectMounter(r *gin.Engine) func(path string, h http.Handler) {
	return func(path string, h http.Handler) {
		r.Any(strings.TrimSuffix(path, "/")+"/*method", gin.WrapH(h))
	}
}

// corsMiddleware 只允许配置中的前端来源跨域访问，并携带 Cookie（为后续会话准备）。
func corsMiddleware(origins []string) gin.HandlerFunc {
	c := cors.New(cors.Options{
		AllowedOrigins:   origins,
		AllowedMethods:   connectcors.AllowedMethods(),
		AllowedHeaders:   connectcors.AllowedHeaders(),
		ExposedHeaders:   connectcors.ExposedHeaders(),
		AllowCredentials: true,
		MaxAge:           7200,
	})
	return func(ctx *gin.Context) {
		c.HandlerFunc(ctx.Writer, ctx.Request)
		// 预检请求在这里结束，不进入业务路由
		if ctx.Request.Method == http.MethodOptions && ctx.GetHeader("Access-Control-Request-Method") != "" {
			ctx.AbortWithStatus(http.StatusNoContent)
			return
		}
		ctx.Next()
	}
}

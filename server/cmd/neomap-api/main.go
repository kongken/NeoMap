// neomap-api：NeoMap 后端服务。
//
//	neomap-api                 启动 HTTP / ConnectRPC 服务（Butterfly）
//	neomap-api migrate up      执行数据库迁移（发布前以 k8s Job 运行）
//	neomap-api migrate down    回滚最近一次迁移
//	neomap-api migrate status  查看迁移状态
//
// 两种模式都读取 BUTTERFLY_CONFIG_FILE_PATH 指向的配置文件
// （BUTTERFLY_CONFIG_TYPE=file）。
package main

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"time"

	"butterfly.orx.me/core"
	"butterfly.orx.me/core/app"
	"butterfly.orx.me/core/mod"
	"github.com/gin-gonic/gin"
	"gopkg.in/yaml.v3"

	neomapapp "github.com/kongken/NeoMap/server/internal/app"
	"github.com/kongken/NeoMap/server/internal/application"
	"github.com/kongken/NeoMap/server/internal/auth"
	"github.com/kongken/NeoMap/server/internal/auth/oauthstate"
	"github.com/kongken/NeoMap/server/internal/auth/session"
	"github.com/kongken/NeoMap/server/internal/config"
	"github.com/kongken/NeoMap/server/internal/health"
	"github.com/kongken/NeoMap/server/internal/migrate"
	"github.com/kongken/NeoMap/server/internal/ratelimit"
	"github.com/kongken/NeoMap/server/internal/repo/user"
	"github.com/kongken/NeoMap/server/internal/storage"
)

const serviceName = "neomap-api"

// 通过 -ldflags "-X main.version=... -X main.commit=..." 注入。
var (
	version = "dev"
	commit  = "unknown"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		if err := runMigrate(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "migrate:", err)
			os.Exit(1)
		}
		return
	}
	serve()
}

func serve() {
	cfg := new(config.AppConfig)
	deps := &neomapapp.Deps{Build: application.BuildInfo{Service: serviceName, Version: version, Commit: commit}}

	svc := core.New(&app.Config{
		Namespace: "neomap",
		Service:   serviceName,
		Config:    cfg,
		InitFunc: []func() error{
			func() error {
				n := cfg.NeoMap.WithDefaults()
				ctx := context.Background()
				db, err := storage.OpenPostgres(ctx, n.Database)
				if err != nil {
					return err
				}
				if n.Database.AutoMigrate {
					if err := migrate.Up(ctx, db); err != nil {
						return err
					}
				}
				rdb, err := storage.Redis(n.Redis)
				if err != nil {
					return err
				}
				if err := validateAuthConfig(n); err != nil {
					return err
				}
				users := user.NewPostgres(db)
				deps.Users = users
				deps.Auth = auth.NewService(n.Auth, n.HTTP.CORSAllowedOrigins,
					auth.BuildProviders(n.Auth),
					session.NewStore(rdb, n.Auth.SessionTTL, n.Auth.SessionRenewBefore),
					oauthstate.NewStore(rdb), users, ratelimit.New(rdb))
				deps.AllowedOrigins = n.HTTP.CORSAllowedOrigins
				deps.TrustedProxies = n.HTTP.TrustedProxies
				deps.Health = health.NewHandler(map[string]health.Checker{
					"postgres": db.PingContext,
					"redis":    func(ctx context.Context) error { return rdb.Ping(ctx).Err() },
				}, 2*time.Second)
				cfg.Print()
				return nil
			},
		},
		// Router 在所有 InitFunc 完成之后调用
		Router: func(r *gin.Engine) {
			if err := neomapapp.Register(r, deps); err != nil {
				panic(err)
			}
		},
	})
	svc.Run()
}

// validateAuthConfig 在启动时检查登录配置，避免上线后才发现回调地址错误。
func validateAuthConfig(n config.NeoMapConfig) error {
	a := n.Auth
	if !a.Providers.GitHub.Enabled() && !a.Providers.Google.Enabled() {
		slog.Warn("no oauth provider configured: login is disabled")
		return nil
	}
	if a.AppBaseURL == "" {
		return fmt.Errorf("neomap.auth.app_base_url 未配置")
	}
	if a.APIBaseURL == "" && (a.Providers.GitHub.RedirectURL == "" || a.Providers.Google.RedirectURL == "") {
		return fmt.Errorf("neomap.auth.api_base_url 未配置（用于推导 OAuth 回调地址）")
	}
	if a.Cookie.Insecure {
		slog.Warn("session cookie is not Secure: only for local http development")
	}
	return nil
}

// fileConfig 是 migrate 子命令需要的配置子集，与 serve 共用同一份 YAML。
type fileConfig struct {
	mod.CoreConfig   `yaml:",inline"`
	config.AppConfig `yaml:",inline"`
}

func runMigrate(args []string) error {
	cmd := "up"
	if len(args) > 0 {
		cmd = args[0]
	}
	path := os.Getenv("BUTTERFLY_CONFIG_FILE_PATH")
	if path == "" {
		return fmt.Errorf("未设置 BUTTERFLY_CONFIG_FILE_PATH")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var fc fileConfig
	if err := yaml.Unmarshal(raw, &fc); err != nil {
		return fmt.Errorf("解析配置失败: %w", err)
	}
	n := fc.NeoMap.WithDefaults()
	dbc, ok := fc.Store.DB[n.Database.Store]
	if !ok {
		return fmt.Errorf("store.db.%s 未配置", n.Database.Store)
	}
	db, err := sql.Open("pgx", storage.PostgresDSN(dbc))
	if err != nil {
		return err
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("连接 PostgreSQL 失败: %w", err)
	}

	switch cmd {
	case "up":
		return migrate.Up(ctx, db)
	case "down":
		return migrate.Down(ctx, db)
	case "status":
		return migrate.Status(ctx, db, os.Stdout)
	default:
		slog.Error("unknown migrate command", "command", cmd)
		return fmt.Errorf("未知命令 %q（可用：up、down、status）", cmd)
	}
}

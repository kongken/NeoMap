// Package config 定义 neomap-api 的应用配置。
//
// Butterfly 从 BUTTERFLY_CONFIG_FILE_PATH 指向的同一份 YAML 中读取两部分：
// 框架自身的 store / log 段（数据库、Redis 连接），以及这里定义的 neomap 段。
package config

import (
	"log/slog"
	"time"
)

// AppConfig 对应配置文件中的顶层 neomap 段。
type AppConfig struct {
	NeoMap NeoMapConfig `yaml:"neomap"`
}

type NeoMapConfig struct {
	HTTP     HTTPConfig     `yaml:"http"`
	Database DatabaseConfig `yaml:"database"`
	Redis    RedisConfig    `yaml:"redis"`
	Auth     AuthConfig     `yaml:"auth"`
}

type HTTPConfig struct {
	// 允许跨域访问 API 的前端来源，例如 https://app.example.com。
	// 同时用于写请求的 Origin 校验（CSRF 防护）。
	CORSAllowedOrigins []string `yaml:"cors_allowed_origins"`
	// 可信反向代理的 IP / CIDR（如 k8s Ingress 所在网段）。只有来自这些地址的
	// X-Forwarded-For 才会被采信用于识别客户端 IP（登录限流使用）。默认不信任任何代理。
	TrustedProxies []string `yaml:"trusted_proxies"`
}

type AuthConfig struct {
	// 前端地址，登录完成后跳回这里，例如 https://app.example.com。
	AppBaseURL string `yaml:"app_base_url"`
	// API 对外地址，用于推导 OAuth 回调地址 {api_base_url}/auth/oauth/{provider}/callback。
	APIBaseURL string       `yaml:"api_base_url"`
	Cookie     CookieConfig `yaml:"cookie"`
	// 会话有效期（默认 720h），剩余不足 SessionRenewBefore（默认 360h）时访问即续期。
	SessionTTL         time.Duration `yaml:"session_ttl"`
	SessionRenewBefore time.Duration `yaml:"session_renew_before"`
	// 每个客户端 IP 每分钟最多发起的登录次数（默认 20）。
	LoginRateLimitPerMinute int             `yaml:"login_rate_limit_per_minute"`
	Providers               ProvidersConfig `yaml:"providers"`
}

type CookieConfig struct {
	Name string `yaml:"name"`
	// 例如 .example.com，使 app. 与 api. 子域共享；留空表示仅当前主机（本地开发）。
	Domain string `yaml:"domain"`
	// 仅本地 http 开发时设为 true；生产环境 Cookie 必须带 Secure。
	Insecure bool `yaml:"insecure"`
}

type ProvidersConfig struct {
	GitHub OAuthProviderConfig `yaml:"github"`
	Google OAuthProviderConfig `yaml:"google"`
}

// OAuthProviderConfig 中 client_id / client_secret 为空的登录方式不会启用。
type OAuthProviderConfig struct {
	ClientID     string `yaml:"client_id"`
	ClientSecret string `yaml:"client_secret"`
	// 留空时由 api_base_url 推导。
	RedirectURL string `yaml:"redirect_url"`
	// 以下仅用于测试或企业版部署，覆盖默认端点。
	AuthURL     string `yaml:"auth_url"`
	TokenURL    string `yaml:"token_url"`
	UserInfoURL string `yaml:"userinfo_url"`
	EmailsURL   string `yaml:"emails_url"`
}

func (p OAuthProviderConfig) Enabled() bool { return p.ClientID != "" && p.ClientSecret != "" }

type DatabaseConfig struct {
	// Butterfly store.db 下的连接名。
	Store string `yaml:"store"`
	// 启动时自动执行迁移（使用 Postgres advisory lock，多副本安全）。
	// 生产环境建议关闭，改为发布前运行 `neomap-api migrate up`。
	AutoMigrate     bool          `yaml:"auto_migrate"`
	MaxOpenConns    int           `yaml:"max_open_conns"`
	MaxIdleConns    int           `yaml:"max_idle_conns"`
	ConnMaxLifetime time.Duration `yaml:"conn_max_lifetime"`
}

type RedisConfig struct {
	// Butterfly store.redis 下的连接名。
	Store string `yaml:"store"`
}

// WithDefaults 返回填充了默认值的配置副本。
func (c NeoMapConfig) WithDefaults() NeoMapConfig {
	if c.Database.Store == "" {
		c.Database.Store = "main"
	}
	if c.Database.MaxOpenConns <= 0 {
		c.Database.MaxOpenConns = 10
	}
	if c.Database.MaxIdleConns <= 0 {
		c.Database.MaxIdleConns = 5
	}
	if c.Database.ConnMaxLifetime <= 0 {
		c.Database.ConnMaxLifetime = 30 * time.Minute
	}
	if c.Redis.Store == "" {
		c.Redis.Store = "main"
	}
	if c.Auth.Cookie.Name == "" {
		c.Auth.Cookie.Name = "neomap_session"
	}
	if c.Auth.SessionTTL <= 0 {
		c.Auth.SessionTTL = 720 * time.Hour
	}
	if c.Auth.SessionRenewBefore <= 0 || c.Auth.SessionRenewBefore >= c.Auth.SessionTTL {
		c.Auth.SessionRenewBefore = c.Auth.SessionTTL / 2
	}
	if c.Auth.LoginRateLimitPerMinute <= 0 {
		c.Auth.LoginRateLimitPerMinute = 20
	}
	return c
}

// Print 实现 Butterfly 的 config.AppConfig 接口；不输出任何敏感信息。
func (c *AppConfig) Print() {
	n := c.NeoMap.WithDefaults()
	slog.Info("neomap config",
		"cors_allowed_origins", n.HTTP.CORSAllowedOrigins,
		"database_store", n.Database.Store,
		"auto_migrate", n.Database.AutoMigrate,
		"redis_store", n.Redis.Store,
		"trusted_proxies", n.HTTP.TrustedProxies,
		"app_base_url", n.Auth.AppBaseURL,
		"api_base_url", n.Auth.APIBaseURL,
		"cookie_domain", n.Auth.Cookie.Domain,
		"cookie_insecure", n.Auth.Cookie.Insecure,
		"github_enabled", n.Auth.Providers.GitHub.Enabled(),
		"google_enabled", n.Auth.Providers.Google.Enabled(),
	)
}

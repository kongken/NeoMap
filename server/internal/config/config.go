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
}

type HTTPConfig struct {
	// 允许跨域访问 API 的前端来源，例如 https://app.example.com。
	CORSAllowedOrigins []string `yaml:"cors_allowed_origins"`
}

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
	)
}

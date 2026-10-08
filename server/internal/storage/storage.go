// Package storage 获取并校验 Butterfly 管理的 PostgreSQL 与 Redis 连接。
package storage

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"time"

	"butterfly.orx.me/core/mod"
	"butterfly.orx.me/core/store/redis"
	"butterfly.orx.me/core/store/sqldb"
	_ "github.com/jackc/pgx/v5/stdlib" // 注册 pgx 驱动（migrate 子命令自行打开连接时使用）

	"github.com/kongken/NeoMap/server/internal/config"
)

const pingTimeout = 5 * time.Second

// OpenPostgres 取出 Butterfly 初始化的连接池，设置池参数并确认可连接。
// Butterfly 只调用 sql.Open，不会主动连接，因此必须在这里 Ping，失败即启动失败。
func OpenPostgres(ctx context.Context, cfg config.DatabaseConfig) (*sql.DB, error) {
	db := sqldb.GetDB(cfg.Store)
	if db == nil {
		return nil, fmt.Errorf("store.db.%s 未配置", cfg.Store)
	}
	db.SetMaxOpenConns(cfg.MaxOpenConns)
	db.SetMaxIdleConns(cfg.MaxIdleConns)
	db.SetConnMaxLifetime(cfg.ConnMaxLifetime)
	pingCtx, cancel := context.WithTimeout(ctx, pingTimeout)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		return nil, fmt.Errorf("连接 PostgreSQL 失败: %w", err)
	}
	return db, nil
}

// Redis 取出 Butterfly 初始化的 Redis 客户端（Butterfly 初始化时已 Ping）。
func Redis(cfg config.RedisConfig) (*redis.Client, error) {
	c := redis.GetClient(cfg.Store)
	if c == nil {
		return nil, fmt.Errorf("store.redis.%s 未配置", cfg.Store)
	}
	return c, nil
}

// PostgresDSN 根据 Butterfly 的 DBConfig 构造连接串，并对用户名和密码做 URL 转义。
// （Butterfly 自身拼接 DSN 时未转义，密码含 @ : / 等字符会失败；见设计文档第 2 节。）
func PostgresDSN(c mod.DBConfig) string {
	sslMode := c.SSLMode
	if sslMode == "" {
		sslMode = "disable"
	}
	u := url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword(c.User, c.Password),
		Host:     fmt.Sprintf("%s:%d", c.Host, c.Port),
		Path:     "/" + c.DBName,
		RawQuery: url.Values{"sslmode": {sslMode}}.Encode(),
	}
	return u.String()
}

// Package pgtest 为集成测试创建独立的临时 PostgreSQL 数据库（已执行迁移），测试结束后删除。
//
// 需要设置 NEOMAP_TEST_POSTGRES_DSN（有 CREATEDB 权限），未设置时跳过测试。
package pgtest

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"net/url"
	"os"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/kongken/NeoMap/server/internal/migrate"
)

func New(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("NEOMAP_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("NEOMAP_TEST_POSTGRES_DSN 未设置，跳过 PostgreSQL 集成测试")
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close() })

	b := make([]byte, 6)
	_, _ = rand.Read(b)
	name := "neomap_test_" + hex.EncodeToString(b)
	if _, err := admin.Exec("CREATE DATABASE " + name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = admin.Exec("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)") })

	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	db, err := sql.Open("pgx", u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := migrate.Up(ctx, db); err != nil {
		t.Fatal(err)
	}
	return db
}

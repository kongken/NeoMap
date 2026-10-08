// Package migrate 使用 goose 执行嵌入的 SQL 迁移。
package migrate

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"log/slog"

	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"

	"github.com/kongken/NeoMap/server/migrations"
)

// NewProvider 创建迁移执行器。使用 Postgres advisory lock，
// 多个副本或 Job 同时执行时只有一个会真正运行迁移。
func NewProvider(db *sql.DB) (*goose.Provider, error) {
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return nil, err
	}
	return goose.NewProvider(goose.DialectPostgres, db, migrations.FS, goose.WithSessionLocker(locker))
}

// Up 执行所有未应用的迁移。
func Up(ctx context.Context, db *sql.DB) error {
	p, err := NewProvider(db)
	if err != nil {
		return err
	}
	results, err := p.Up(ctx)
	for _, r := range results {
		slog.Info("migration applied", "version", r.Source.Version, "path", r.Source.Path, "duration", r.Duration)
	}
	if err != nil {
		return fmt.Errorf("执行迁移失败: %w", err)
	}
	return nil
}

// Down 回滚最近一次迁移。
func Down(ctx context.Context, db *sql.DB) error {
	p, err := NewProvider(db)
	if err != nil {
		return err
	}
	r, err := p.Down(ctx)
	if r != nil {
		slog.Info("migration rolled back", "version", r.Source.Version, "path", r.Source.Path)
	}
	return err
}

// Status 输出每个迁移的状态。
func Status(ctx context.Context, db *sql.DB, w io.Writer) error {
	p, err := NewProvider(db)
	if err != nil {
		return err
	}
	statuses, err := p.Status(ctx)
	if err != nil {
		return err
	}
	for _, s := range statuses {
		applied := "pending"
		if s.State == goose.StateApplied {
			applied = "applied " + s.AppliedAt.Format("2006-01-02 15:04:05")
		}
		if _, err := fmt.Fprintf(w, "%05d  %-40s  %s\n", s.Source.Version, s.Source.Path, applied); err != nil {
			return err
		}
	}
	return nil
}

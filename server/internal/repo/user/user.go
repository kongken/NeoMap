// Package user 管理用户与第三方登录身份。
package user

import (
	"context"
	"errors"
	"time"

	"github.com/kongken/NeoMap/server/internal/auth/provider"
)

var ErrNotFound = errors.New("用户不存在")

type User struct {
	ID          string
	DisplayName string
	Email       string
	AvatarURL   string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type Repository interface {
	// UpsertFromIdentity 按 (provider, subject) 查找用户；不存在则创建，存在则用最新资料更新。
	// 不按邮箱自动合并不同登录方式的账号（避免借助未验证邮箱接管账号）。
	UpsertFromIdentity(ctx context.Context, id *provider.Identity) (*User, error)
	Get(ctx context.Context, userID string) (*User, error)
}

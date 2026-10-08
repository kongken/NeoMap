package user

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/kongken/NeoMap/server/internal/auth/provider"
)

type Postgres struct{ db *sql.DB }

func NewPostgres(db *sql.DB) *Postgres { return &Postgres{db: db} }

var _ Repository = (*Postgres)(nil)

func nullable(s string) sql.NullString { return sql.NullString{String: s, Valid: s != ""} }

const selectUser = `SELECT id, display_name, coalesce(email, ''), coalesce(avatar_url, ''), created_at, updated_at FROM users`

func scanUser(row interface{ Scan(...any) error }) (*User, error) {
	u := &User{}
	if err := row.Scan(&u.ID, &u.DisplayName, &u.Email, &u.AvatarURL, &u.CreatedAt, &u.UpdatedAt); err != nil {
		return nil, err
	}
	return u, nil
}

func (p *Postgres) Get(ctx context.Context, userID string) (*User, error) {
	if _, err := uuid.Parse(userID); err != nil {
		return nil, ErrNotFound
	}
	u, err := scanUser(p.db.QueryRowContext(ctx, selectUser+` WHERE id = $1`, userID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return u, err
}

func (p *Postgres) UpsertFromIdentity(ctx context.Context, id *provider.Identity) (*User, error) {
	// 两次尝试：并发首次登录时，另一个请求可能已先插入同一身份
	for attempt := 0; attempt < 2; attempt++ {
		u, retry, err := p.upsertOnce(ctx, id)
		if err != nil || !retry {
			return u, err
		}
	}
	return nil, fmt.Errorf("创建用户失败：身份冲突")
}

func (p *Postgres) upsertOnce(ctx context.Context, id *provider.Identity) (u *User, retry bool, err error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, err
	}
	defer func() {
		if err != nil || retry {
			_ = tx.Rollback()
		}
	}()

	var userID string
	err = tx.QueryRowContext(ctx,
		`SELECT user_id FROM user_identities WHERE provider = $1 AND provider_user_id = $2 FOR UPDATE`,
		id.Provider, id.Subject).Scan(&userID)
	switch {
	case err == nil:
		// 已有用户：同步最新资料
		u, err = scanUser(tx.QueryRowContext(ctx,
			`UPDATE users SET display_name = $2, email = $3, avatar_url = $4, updated_at = now() WHERE id = $1
			 RETURNING id, display_name, coalesce(email, ''), coalesce(avatar_url, ''), created_at, updated_at`,
			userID, id.DisplayName, nullable(id.Email), nullable(id.AvatarURL)))
		if err != nil {
			return nil, false, err
		}
		if _, err = tx.ExecContext(ctx,
			`UPDATE user_identities SET email = $3 WHERE provider = $1 AND provider_user_id = $2`,
			id.Provider, id.Subject, nullable(id.Email)); err != nil {
			return nil, false, err
		}
	case errors.Is(err, sql.ErrNoRows):
		newID := uuid.NewString()
		u, err = scanUser(tx.QueryRowContext(ctx,
			`INSERT INTO users (id, display_name, email, avatar_url) VALUES ($1, $2, $3, $4)
			 RETURNING id, display_name, coalesce(email, ''), coalesce(avatar_url, ''), created_at, updated_at`,
			newID, id.DisplayName, nullable(id.Email), nullable(id.AvatarURL)))
		if err != nil {
			return nil, false, err
		}
		res, e := tx.ExecContext(ctx,
			`INSERT INTO user_identities (provider, provider_user_id, user_id, email) VALUES ($1, $2, $3, $4)
			 ON CONFLICT (provider, provider_user_id) DO NOTHING`,
			id.Provider, id.Subject, newID, nullable(id.Email))
		if e != nil {
			return nil, false, e
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil, true, nil
		}
	default:
		return nil, false, err
	}
	if err = tx.Commit(); err != nil {
		return nil, false, err
	}
	return u, false, nil
}

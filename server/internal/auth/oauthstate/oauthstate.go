// Package oauthstate 保存 OAuth 登录过程中的一次性 state（防 CSRF）与 PKCE verifier。
package oauthstate

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// TTL：用户需在 10 分钟内完成授权页面操作。
const TTL = 10 * time.Minute

var ErrInvalid = errors.New("登录状态无效或已过期")

type Entry struct {
	Provider string `json:"provider"`
	Verifier string `json:"verifier"`
	ReturnTo string `json:"return_to"`
}

type Store struct{ rdb redis.Cmdable }

func NewStore(rdb redis.Cmdable) *Store { return &Store{rdb: rdb} }

func key(state string) string { return "neomap:oauth:state:" + state }

// Create 保存 entry，返回随机 state。
func (s *Store) Create(ctx context.Context, e Entry) (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	state := base64.RawURLEncoding.EncodeToString(buf)
	data, err := json.Marshal(e)
	if err != nil {
		return "", err
	}
	if err := s.rdb.Set(ctx, key(state), data, TTL).Err(); err != nil {
		return "", err
	}
	return state, nil
}

// Consume 取出并删除 state（GETDEL，保证只能使用一次）。
func (s *Store) Consume(ctx context.Context, state string) (*Entry, error) {
	if state == "" || len(state) > 64 {
		return nil, ErrInvalid
	}
	raw, err := s.rdb.GetDel(ctx, key(state)).Result()
	if errors.Is(err, redis.Nil) {
		return nil, ErrInvalid
	}
	if err != nil {
		return nil, err
	}
	var e Entry
	if err := json.Unmarshal([]byte(raw), &e); err != nil {
		return nil, ErrInvalid
	}
	return &e, nil
}

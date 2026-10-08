// Package session 在 Redis 中保存登录会话。
//
// Cookie 里放随机令牌，Redis 只保存其 SHA-256 摘要，Redis 数据泄露也无法直接冒用会话。
//
//	neomap:session:<hash>          → JSON{user_id, provider, created_at, user_agent}，带 TTL
//	neomap:user-sessions:<user_id> → Set<hash>，用于「退出所有设备」
package session

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var ErrNotFound = errors.New("会话不存在或已过期")

type Session struct {
	UserID    string    `json:"user_id"`
	Provider  string    `json:"provider"`
	CreatedAt time.Time `json:"created_at"`
	UserAgent string    `json:"user_agent,omitempty"`
	// Hash 是令牌摘要，不序列化
	Hash string `json:"-"`
}

type Store struct {
	rdb         redis.Cmdable
	ttl         time.Duration
	renewBefore time.Duration
	now         func() time.Time
}

func NewStore(rdb redis.Cmdable, ttl, renewBefore time.Duration) *Store {
	return &Store{rdb: rdb, ttl: ttl, renewBefore: renewBefore, now: time.Now}
}

func (s *Store) TTL() time.Duration { return s.ttl }

func sessionKey(hash string) string        { return "neomap:session:" + hash }
func userSessionsKey(userID string) string { return "neomap:user-sessions:" + userID }

// HashToken 返回令牌的摘要。
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// Create 签发新会话，返回放进 Cookie 的令牌。
func (s *Store) Create(ctx context.Context, userID, provider, userAgent string) (string, *Session, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", nil, err
	}
	token := base64.RawURLEncoding.EncodeToString(buf)
	if len(userAgent) > 256 {
		userAgent = userAgent[:256]
	}
	sess := &Session{UserID: userID, Provider: provider, CreatedAt: s.now().UTC(), UserAgent: userAgent, Hash: HashToken(token)}
	data, err := json.Marshal(sess)
	if err != nil {
		return "", nil, err
	}
	_, err = s.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.Set(ctx, sessionKey(sess.Hash), data, s.ttl)
		p.SAdd(ctx, userSessionsKey(userID), sess.Hash)
		p.Expire(ctx, userSessionsKey(userID), s.ttl)
		return nil
	})
	if err != nil {
		return "", nil, fmt.Errorf("保存会话失败: %w", err)
	}
	return token, sess, nil
}

// Lookup 查找令牌对应的会话。剩余有效期不足 renewBefore 时自动续期，renewed 为 true，
// 调用方应同时刷新 Cookie 的有效期。
func (s *Store) Lookup(ctx context.Context, token string) (sess *Session, renewed bool, err error) {
	if token == "" {
		return nil, false, ErrNotFound
	}
	hash := HashToken(token)
	var get *redis.StringCmd
	var ttl *redis.DurationCmd
	_, err = s.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		get = p.Get(ctx, sessionKey(hash))
		ttl = p.PTTL(ctx, sessionKey(hash))
		return nil
	})
	if errors.Is(get.Err(), redis.Nil) {
		return nil, false, ErrNotFound
	}
	if err != nil {
		return nil, false, err
	}
	sess = &Session{}
	if err := json.Unmarshal([]byte(get.Val()), sess); err != nil {
		return nil, false, fmt.Errorf("会话数据损坏: %w", err)
	}
	sess.Hash = hash

	if remaining := ttl.Val(); remaining > 0 && remaining < s.renewBefore {
		_, err := s.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
			p.Expire(ctx, sessionKey(hash), s.ttl)
			p.Expire(ctx, userSessionsKey(sess.UserID), s.ttl)
			return nil
		})
		if err != nil {
			return nil, false, err
		}
		renewed = true
	}
	return sess, renewed, nil
}

// Revoke 删除单个会话。
func (s *Store) Revoke(ctx context.Context, sess *Session) error {
	_, err := s.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.Del(ctx, sessionKey(sess.Hash))
		p.SRem(ctx, userSessionsKey(sess.UserID), sess.Hash)
		return nil
	})
	return err
}

// RevokeAll 删除用户的全部会话（退出所有设备、注销账号）。
func (s *Store) RevokeAll(ctx context.Context, userID string) error {
	hashes, err := s.rdb.SMembers(ctx, userSessionsKey(userID)).Result()
	if err != nil {
		return err
	}
	keys := make([]string, 0, len(hashes)+1)
	for _, h := range hashes {
		keys = append(keys, sessionKey(h))
	}
	keys = append(keys, userSessionsKey(userID))
	return s.rdb.Del(ctx, keys...).Err()
}

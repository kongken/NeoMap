package user

import (
	"context"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/kongken/NeoMap/server/internal/auth/provider"
)

// Memory 是内存实现，用于单元测试。
type Memory struct {
	mu         sync.Mutex
	users      map[string]*User
	identities map[string]string // provider|subject → user id
}

func NewMemory() *Memory {
	return &Memory{users: map[string]*User{}, identities: map[string]string{}}
}

var _ Repository = (*Memory)(nil)

func (m *Memory) Get(_ context.Context, userID string) (*User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.users[userID]
	if !ok {
		return nil, ErrNotFound
	}
	cp := *u
	return &cp, nil
}

func (m *Memory) UpsertFromIdentity(_ context.Context, id *provider.Identity) (*User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := id.Provider + "|" + id.Subject
	now := time.Now().UTC()
	uid, ok := m.identities[key]
	if !ok {
		uid = uuid.NewString()
		m.identities[key] = uid
		m.users[uid] = &User{ID: uid, CreatedAt: now}
	}
	u := m.users[uid]
	u.DisplayName, u.Email, u.AvatarURL, u.UpdatedAt = id.DisplayName, id.Email, id.AvatarURL, now
	cp := *u
	return &cp, nil
}

// Delete 删除用户（测试「会话指向已删除用户」）。
func (m *Memory) Delete(userID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.users, userID)
}

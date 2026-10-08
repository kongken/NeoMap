package user

import (
	"context"
	"database/sql"
	"sync"
	"testing"

	"github.com/kongken/NeoMap/server/internal/auth/provider"
	"github.com/kongken/NeoMap/server/internal/testsupport/pgtest"
)

func testRepo(t *testing.T) (*Postgres, *sql.DB) {
	t.Helper()
	db := pgtest.New(t)
	return NewPostgres(db), db
}

func TestPostgresUpsertAndGet(t *testing.T) {
	repo, _ := testRepo(t)
	ctx := context.Background()

	gh := &provider.Identity{Provider: "github", Subject: "42", DisplayName: "Octo", Email: "octo@example.com", AvatarURL: "https://a/1"}
	u1, err := repo.UpsertFromIdentity(ctx, gh)
	if err != nil {
		t.Fatal(err)
	}
	got, err := repo.Get(ctx, u1.ID)
	if err != nil || got.DisplayName != "Octo" || got.Email != "octo@example.com" {
		t.Fatalf("Get = %+v, %v", got, err)
	}

	// 同一身份再次登录：同一用户，资料更新；空邮箱存为 NULL、读出为空串
	gh2 := &provider.Identity{Provider: "github", Subject: "42", DisplayName: "Octo 2"}
	u2, err := repo.UpsertFromIdentity(ctx, gh2)
	if err != nil || u2.ID != u1.ID || u2.DisplayName != "Octo 2" || u2.Email != "" {
		t.Fatalf("再次登录：%+v, %v", u2, err)
	}

	// 其他登录方式即使邮箱相同，也是不同用户（不自动合并）
	g := &provider.Identity{Provider: "google", Subject: "42", DisplayName: "Octo", Email: "octo@example.com"}
	u3, err := repo.UpsertFromIdentity(ctx, g)
	if err != nil || u3.ID == u1.ID {
		t.Fatalf("不同登录方式应为不同用户：%+v, %v", u3, err)
	}

	if _, err := repo.Get(ctx, "not-a-uuid"); err != ErrNotFound {
		t.Fatalf("非法 ID：%v", err)
	}
	if _, err := repo.Get(ctx, "00000000-0000-4000-8000-000000000000"); err != ErrNotFound {
		t.Fatalf("不存在的用户：%v", err)
	}
}

func TestPostgresConcurrentFirstLogin(t *testing.T) {
	repo, db := testRepo(t)
	ctx := context.Background()
	id := &provider.Identity{Provider: "github", Subject: "race", DisplayName: "Racer"}

	const n = 8
	ids := make([]string, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			u, err := repo.UpsertFromIdentity(ctx, id)
			errs[i] = err
			if u != nil {
				ids[i] = u.ID
			}
		}()
	}
	wg.Wait()
	for i := 0; i < n; i++ {
		if errs[i] != nil {
			t.Fatalf("并发登录 %d：%v", i, errs[i])
		}
		if ids[i] != ids[0] {
			t.Fatalf("并发首次登录产生了不同用户：%v", ids)
		}
	}
	var users int
	if err := db.QueryRow(`SELECT count(*) FROM users`).Scan(&users); err != nil {
		t.Fatal(err)
	}
	if users != 1 {
		t.Fatalf("应只有 1 个用户，实际 %d（失败事务未回滚）", users)
	}
}

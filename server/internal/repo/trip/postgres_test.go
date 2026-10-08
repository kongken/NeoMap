package trip

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kongken/NeoMap/server/internal/testsupport/pgtest"
)

var ctx = context.Background()

func setup(t *testing.T) (*Postgres, *sql.DB, string) {
	t.Helper()
	db := pgtest.New(t)
	return NewPostgres(db), db, newUser(t, db)
}

func newUser(t *testing.T, db *sql.DB) string {
	t.Helper()
	id := uuid.NewString()
	if _, err := db.Exec(`INSERT INTO users (id, display_name) VALUES ($1, 'u')`, id); err != nil {
		t.Fatal(err)
	}
	return id
}

var ts = time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC)

// sample 构造一个两段航程的行程：ICN → HKT → ICN
func sample(tripID string) *Bundle {
	return &Bundle{
		Trip: Trip{ID: tripID, Title: "亚洲假期", StartDate: "2026-09-26", EndDate: "2026-10-05", Notes: "备注", CreatedAt: ts, UpdatedAt: ts},
		Airports: []Airport{
			{ID: "oa:5653", IATA: "ICN", Name: "Incheon", NameZh: "仁川国际机场", City: "Seoul", CityZh: "首尔", Aliases: []string{"仁川", "首尔仁川"}, CountryCode: "KR", Latitude: 37.4691, Longitude: 126.451},
			{ID: "oa:26674", IATA: "HKT", Name: "Phuket", CountryCode: "TH", Latitude: 8.11326, Longitude: 98.3174},
		},
		Legs: []Leg{
			{ID: uuid.NewString(), Order: 0, DepartureAirportID: "oa:5653", ArrivalAirportID: "oa:26674", DepartureDate: "2026-09-26", FlightNumber: "KE 637", CreatedAt: ts, UpdatedAt: ts},
			{ID: uuid.NewString(), Order: 1, DepartureAirportID: "oa:26674", ArrivalAirportID: "oa:5653", DepartureDate: "2026-10-02", CreatedAt: ts, UpdatedAt: ts},
		},
	}
}

func TestPutCreateUpdateRoundTrip(t *testing.T) {
	repo, _, user := setup(t)
	b := sample(uuid.NewString())

	got, err := repo.Put(ctx, user, b, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got.Revision != 1 || got.Deleted || got.ChangeSeq == 0 {
		t.Fatalf("新建：revision=%d deleted=%v seq=%d", got.Revision, got.Deleted, got.ChangeSeq)
	}
	if !SameContent(got, b) {
		t.Fatalf("读回内容不一致：\n got %+v\nwant %+v", got, b)
	}
	if got.Airports[0].ID != "oa:26674" || len(got.Airports[1].Aliases) != 2 {
		t.Fatalf("机场快照（按 ID 排序、别名数组）：%+v", got.Airports)
	}

	// 更新：改标题、删一段、换机场
	b2 := sample(b.Trip.ID)
	b2.Trip.Title = "改名"
	b2.Trip.StartDate, b2.Trip.EndDate, b2.Trip.Notes = "", "", ""
	b2.Legs = b2.Legs[:1]
	got2, err := repo.Put(ctx, user, b2, 1)
	if err != nil {
		t.Fatal(err)
	}
	if got2.Revision != 2 || got2.ChangeSeq <= got.ChangeSeq || !SameContent(got2, b2) {
		t.Fatalf("更新：%+v", got2)
	}
}

func TestPutConflictsAndRetry(t *testing.T) {
	repo, _, user := setup(t)
	b := sample(uuid.NewString())
	if _, err := repo.Put(ctx, user, b, 0); err != nil {
		t.Fatal(err)
	}

	// 响应丢失后的重试（相同内容、旧 base_revision）：视为成功，不产生新版本
	again, err := repo.Put(ctx, user, b, 0)
	if err != nil || again.Revision != 1 {
		t.Fatalf("幂等重试：%+v, %v", again, err)
	}

	// 其他设备已修改：内容不同 → 冲突，附带服务端当前版本
	b.Trip.Title = "本设备的修改"
	_, err = repo.Put(ctx, user, b, 0)
	var conflict *ConflictError
	if !errors.As(err, &conflict) || conflict.Current.Revision != 1 || conflict.Current.Trip.Title != "亚洲假期" {
		t.Fatalf("冲突：%v", err)
	}

	// base_revision > 0 但行程不存在
	if _, err := repo.Put(ctx, user, sample(uuid.NewString()), 3); !errors.Is(err, ErrNotFound) {
		t.Fatalf("不存在的行程：%v", err)
	}
}

func TestPutIDOwnership(t *testing.T) {
	repo, db, alice := setup(t)
	bob := newUser(t, db)
	b := sample(uuid.NewString())
	if _, err := repo.Put(ctx, alice, b, 0); err != nil {
		t.Fatal(err)
	}
	// 行程 ID 属于其他用户
	if _, err := repo.Put(ctx, bob, b, 0); !errors.Is(err, ErrIDTaken) {
		t.Fatalf("行程 ID 被占用：%v", err)
	}
	// 航段 ID 被其他行程占用
	other := sample(uuid.NewString())
	other.Legs[0].ID = b.Legs[0].ID
	if _, err := repo.Put(ctx, bob, other, 0); !errors.Is(err, ErrIDTaken) {
		t.Fatalf("航段 ID 被占用：%v", err)
	}
	// 失败的写入整体回滚：bob 没有任何行程
	if got, _ := repo.ListChanges(ctx, bob, 0, 100); len(got) != 0 {
		t.Fatalf("失败写入产生了部分数据：%d", len(got))
	}
	// bob 删除 alice 的行程：按不存在处理
	if _, err := repo.Delete(ctx, bob, b.Trip.ID, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("删除他人行程：%v", err)
	}
}

func TestDeleteTombstoneAndResurrect(t *testing.T) {
	repo, db, user := setup(t)
	b := sample(uuid.NewString())
	if _, err := repo.Put(ctx, user, b, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Delete(ctx, user, b.Trip.ID, 7); !errorsAsConflict(err) {
		t.Fatalf("版本不一致的删除：%v", err)
	}
	tomb, err := repo.Delete(ctx, user, b.Trip.ID, 1)
	if err != nil || !tomb.Deleted || tomb.Revision != 2 {
		t.Fatalf("删除：%+v, %v", tomb, err)
	}
	// 墓碑不保留内容
	if tomb.Trip.Title != "" || len(tomb.Legs) != 0 || len(tomb.Airports) != 0 {
		t.Fatalf("墓碑仍含内容：%+v", tomb)
	}
	var notes sql.NullString
	var title string
	_ = db.QueryRow(`SELECT title, notes FROM trips WHERE id = $1`, b.Trip.ID).Scan(&title, &notes)
	if title != "deleted" || notes.Valid {
		t.Fatalf("数据库中墓碑仍含用户内容：%q %v", title, notes)
	}
	// 重复删除（其他设备也删了）：幂等
	if again, err := repo.Delete(ctx, user, b.Trip.ID, 1); err != nil || again.Revision != 2 {
		t.Fatalf("重复删除：%+v, %v", again, err)
	}
	// 用旧版本修改已删除的行程 → 冲突（客户端据此另存副本）
	if _, err := repo.Put(ctx, user, b, 1); !errorsAsConflict(err) {
		t.Fatalf("修改已删除行程：%v", err)
	}
	// 基于墓碑版本写入：恢复
	back, err := repo.Put(ctx, user, b, 2)
	if err != nil || back.Deleted || back.Revision != 3 || !SameContent(back, b) {
		t.Fatalf("恢复：%+v, %v", back, err)
	}
}

func errorsAsConflict(err error) bool {
	var c *ConflictError
	return errors.As(err, &c)
}

func TestListChangesPagingAndCursor(t *testing.T) {
	repo, db, user := setup(t)
	other := newUser(t, db)
	if _, err := repo.Put(ctx, other, sample(uuid.NewString()), 0); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for i := 0; i < 5; i++ {
		b := sample(uuid.NewString())
		b.Trip.Title = fmt.Sprintf("T%d", i)
		if _, err := repo.Put(ctx, user, b, 0); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, b.Trip.ID)
	}
	// 修改第 0 个：它应排到最后
	b0 := sample(ids[0])
	b0.Trip.Title = "T0-edited"
	if _, err := repo.Put(ctx, user, b0, 1); err != nil {
		t.Fatal(err)
	}

	var seen []string
	var cursor int64
	for page := 0; page < 10; page++ {
		got, err := repo.ListChanges(ctx, user, cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) == 0 {
			break
		}
		for _, b := range got {
			if b.ChangeSeq <= cursor {
				t.Fatalf("游标未递增：%d <= %d", b.ChangeSeq, cursor)
			}
			cursor = b.ChangeSeq
			seen = append(seen, b.Trip.Title)
		}
	}
	want := []string{"T1", "T2", "T3", "T4", "T0-edited"}
	if fmt.Sprint(seen) != fmt.Sprint(want) {
		t.Fatalf("分页顺序 %v，want %v（不应包含其他用户的行程）", seen, want)
	}
	// 游标之后无变更
	if got, _ := repo.ListChanges(ctx, user, cursor, 10); len(got) != 0 {
		t.Fatalf("游标之后不应有变更：%d", len(got))
	}
	// 删除也会出现在增量里
	if _, err := repo.Delete(ctx, user, ids[1], 1); err != nil {
		t.Fatal(err)
	}
	got, _ := repo.ListChanges(ctx, user, cursor, 10)
	if len(got) != 1 || !got[0].Deleted || got[0].Trip.ID != ids[1] {
		t.Fatalf("删除的增量：%+v", got)
	}
}

func TestPurgeTombstonesExpiresOldCursors(t *testing.T) {
	repo, db, user := setup(t)
	keep := sample(uuid.NewString())
	gone := sample(uuid.NewString())
	for _, b := range []*Bundle{keep, gone} {
		if _, err := repo.Put(ctx, user, b, 0); err != nil {
			t.Fatal(err)
		}
	}
	all, _ := repo.ListChanges(ctx, user, 0, 10)
	oldCursor := all[0].ChangeSeq // 只看过第一个行程的设备
	tomb, err := repo.Delete(ctx, user, gone.Trip.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	// 把墓碑的删除时间调到 100 天前，然后清理 90 天以前的墓碑
	if _, err := db.Exec(`UPDATE trips SET deleted_at = now() - interval '100 days' WHERE id = $1`, gone.Trip.ID); err != nil {
		t.Fatal(err)
	}
	n, err := repo.PurgeTombstones(ctx, time.Now().Add(-90*24*time.Hour))
	if err != nil || n != 1 {
		t.Fatalf("清理：n=%d err=%v", n, err)
	}
	// 落在清理水位之前的游标已过期
	if _, err := repo.ListChanges(ctx, user, oldCursor, 10); !errors.Is(err, ErrCursorExpired) {
		t.Fatalf("旧游标：%v", err)
	}
	// 全量同步与水位之后的游标仍可用
	if got, err := repo.ListChanges(ctx, user, 0, 10); err != nil || len(got) != 1 || got[0].Trip.ID != keep.Trip.ID {
		t.Fatalf("全量：%v %v", got, err)
	}
	if _, err := repo.ListChanges(ctx, user, tomb.ChangeSeq, 10); err != nil {
		t.Fatalf("水位之后的游标：%v", err)
	}
}

func TestTripLimit(t *testing.T) {
	repo, db, user := setup(t)
	// 直接插入到上限，避免逐个调用 Put
	if _, err := db.Exec(`
		INSERT INTO trips (id, user_id, title, created_at, updated_at)
		SELECT gen_random_uuid(), $1, 't', now(), now() FROM generate_series(1, $2)`, user, MaxActiveTripsPerUser); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Put(ctx, user, sample(uuid.NewString()), 0); !errors.Is(err, ErrTripLimit) {
		t.Fatalf("超过上限：%v", err)
	}
}

// 同一用户并发写入不同行程：变更序号的提交顺序必须与取号顺序一致，
// 否则读取方游标越过较小的号后会永久漏掉变更。乱序依赖调度时机，因此重复多轮。
func TestConcurrentWritesKeepCursorOrder(t *testing.T) {
	repo, _, user := setup(t)
	var cursor int64
	for round := 0; round < 8; round++ {
		const n = 30
		seen := map[string]bool{}
		stop := make(chan struct{})
		readerDone := make(chan error, 1)
		// 读取方在写入进行中不断增量拉取
		go func() {
			for {
				got, err := repo.ListChanges(ctx, user, cursor, 100)
				if err != nil {
					readerDone <- err
					return
				}
				for _, b := range got {
					seen[b.Trip.ID] = true
					cursor = b.ChangeSeq
				}
				select {
				case <-stop:
					readerDone <- nil
					return
				default:
				}
			}
		}()
		ids := make([]string, n)
		errs := make(chan error, n)
		var wg sync.WaitGroup
		for i := 0; i < n; i++ {
			ids[i] = uuid.NewString()
			wg.Add(1)
			go func() {
				defer wg.Done()
				if _, err := repo.Put(ctx, user, sample(ids[i]), 0); err != nil {
					errs <- err
				}
			}()
		}
		wg.Wait()
		close(stop)
		if err := <-readerDone; err != nil {
			t.Fatal(err)
		}
		close(errs)
		for err := range errs {
			t.Fatal(err)
		}
		// 写入全部完成后再拉一次
		got, err := repo.ListChanges(ctx, user, cursor, 100)
		if err != nil {
			t.Fatal(err)
		}
		for _, b := range got {
			seen[b.Trip.ID] = true
			cursor = b.ChangeSeq
		}
		for _, id := range ids {
			if !seen[id] {
				t.Fatalf("第 %d 轮：增量同步漏掉了行程 %s", round, id)
			}
		}
	}
}

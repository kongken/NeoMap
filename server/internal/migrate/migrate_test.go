package migrate

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// 集成测试：需要一个有 CREATEDB 权限的 PostgreSQL。
// 本地：cd server && docker compose up -d --wait
//
//	NEOMAP_TEST_POSTGRES_DSN=postgres://neomap:neomap@localhost:5433/neomap?sslmode=disable go test ./...
//
// 未设置环境变量时跳过。每个测试使用独立的临时数据库，结束后删除。
func testDB(t *testing.T) *sql.DB {
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
	ctx := context.Background()
	if _, err := admin.ExecContext(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.ExecContext(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
	})

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
	return db
}

func TestMigrationsUpDownUp(t *testing.T) {
	db := testDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	if err := Up(ctx, db); err != nil {
		t.Fatalf("up: %v", err)
	}
	// 再次执行是空操作
	if err := Up(ctx, db); err != nil {
		t.Fatalf("second up: %v", err)
	}
	count := func(q string) int {
		t.Helper()
		var n int
		if err := db.QueryRowContext(ctx, q).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	horizonCol := `SELECT count(*) FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'tombstones_purged_through'`
	tripsTable := `SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'trips'`

	// 逐个回滚：00002 → 00001
	if err := Down(ctx, db); err != nil {
		t.Fatalf("down 00002: %v", err)
	}
	if count(horizonCol) != 0 || count(tripsTable) != 1 {
		t.Fatal("回滚 00002 后状态不正确")
	}
	if err := Down(ctx, db); err != nil {
		t.Fatalf("down 00001: %v", err)
	}
	if count(tripsTable) != 0 {
		t.Fatal("回滚 00001 后 trips 表仍存在")
	}
	if err := Up(ctx, db); err != nil {
		t.Fatalf("up after down: %v", err)
	}

	var status strings.Builder
	if err := Status(ctx, db, &status); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(status.String(), "00001_init.sql") || !strings.Contains(status.String(), "00002_tombstone_horizon.sql") || strings.Contains(status.String(), "pending") {
		t.Fatalf("unexpected status output: %q", status.String())
	}
}

func TestSchemaConstraints(t *testing.T) {
	db := testDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := Up(ctx, db); err != nil {
		t.Fatal(err)
	}

	mustExec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	mustFail := func(what, q string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, q, args...); err == nil {
			t.Fatalf("%s：预期被拒绝，但执行成功", what)
		}
	}

	const user = "00000000-0000-4000-8000-000000000001"
	const trip = "00000000-0000-4000-8000-000000000002"
	now := time.Now()
	mustExec(`INSERT INTO users (id, display_name) VALUES ($1, 'Tester')`, user)
	mustExec(`INSERT INTO trips (id, user_id, title, start_date, end_date, created_at, updated_at) VALUES ($1, $2, '亚洲假期', '2026-09-26', '2026-10-05', $3, $3)`, trip, user, now)
	mustExec(`INSERT INTO trip_airports (trip_id, airport_id, iata, name, country_code, latitude, longitude) VALUES
		($1, 'oa:5653', 'ICN', 'Incheon International Airport', 'KR', 37.4691, 126.451),
		($1, 'oa:26674', 'HKT', 'Phuket International Airport', 'TH', 8.11326, 98.3174)`, trip)
	mustExec(`INSERT INTO flight_legs (id, trip_id, ord, departure_airport_id, arrival_airport_id, departure_date, created_at, updated_at) VALUES
		('00000000-0000-4000-8000-000000000010', $1, 0, 'oa:5653', 'oa:26674', '2026-09-26', $2, $2),
		('00000000-0000-4000-8000-000000000011', $1, 1, 'oa:26674', 'oa:5653', '2026-10-02', $2, $2)`, trip, now)

	// 每次写入都分配新的变更序号
	var seq1, seq2 int64
	if err := db.QueryRowContext(ctx, `SELECT change_seq FROM trips WHERE id = $1`, trip).Scan(&seq1); err != nil {
		t.Fatal(err)
	}
	mustExec(`UPDATE trips SET revision = revision + 1, change_seq = nextval('trip_change_seq') WHERE id = $1`, trip)
	if err := db.QueryRowContext(ctx, `SELECT change_seq FROM trips WHERE id = $1`, trip).Scan(&seq2); err != nil {
		t.Fatal(err)
	}
	if seq2 <= seq1 {
		t.Fatalf("change_seq 未递增：%d -> %d", seq1, seq2)
	}

	// 航段顺序在事务内交换（唯一约束延迟到提交时检查）
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE flight_legs SET ord = 1 - ord WHERE trip_id = $1`, trip); err != nil {
		_ = tx.Rollback()
		t.Fatalf("swap ord: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit swap: %v", err)
	}

	mustFail("标题为空", `INSERT INTO trips (id, user_id, title, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000003', $1, '', $2, $2)`, user, now)
	mustFail("结束日期早于开始日期", `INSERT INTO trips (id, user_id, title, start_date, end_date, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000004', $1, 'x', '2026-10-05', '2026-09-01', $2, $2)`, user, now)
	mustFail("纬度越界", `INSERT INTO trip_airports (trip_id, airport_id, iata, name, country_code, latitude, longitude) VALUES ($1, 'bad', 'BAD', 'x', 'XX', 91, 0)`, trip)
	mustFail("IATA 非大写三字母", `INSERT INTO trip_airports (trip_id, airport_id, iata, name, country_code, latitude, longitude) VALUES ($1, 'bad2', 'ab1', 'x', 'XX', 0, 0)`, trip)
	mustFail("航段引用不存在的机场快照", `INSERT INTO flight_legs (id, trip_id, ord, departure_airport_id, arrival_airport_id, departure_date, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000012', $1, 2, 'oa:5653', 'oa:missing', '2026-10-05', $2, $2)`, trip, now)
	mustFail("同一航段起终点相同", `INSERT INTO flight_legs (id, trip_id, ord, departure_airport_id, arrival_airport_id, departure_date, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000013', $1, 2, 'oa:5653', 'oa:5653', '2026-10-05', $2, $2)`, trip, now)
	mustFail("航段顺序重复", `INSERT INTO flight_legs (id, trip_id, ord, departure_airport_id, arrival_airport_id, departure_date, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000014', $1, 0, 'oa:5653', 'oa:26674', '2026-10-05', $2, $2)`, trip, now)

	// 删除用户级联删除其全部数据
	mustExec(`DELETE FROM users WHERE id = $1`, user)
	var left int
	if err := db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM trips) + (SELECT count(*) FROM trip_airports) + (SELECT count(*) FROM flight_legs)`).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 0 {
		t.Fatalf("删除用户后仍有 %d 行残留", left)
	}
}

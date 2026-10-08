package trip

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

// pgTypes 用于在 database/sql 中扫描 PostgreSQL 数组。
var pgTypes = pgtype.NewMap()

type Postgres struct{ db *sql.DB }

func NewPostgres(db *sql.DB) *Postgres { return &Postgres{db: db} }

func nullable(s string) sql.NullString { return sql.NullString{String: s, Valid: s != ""} }

// queryer 同时适用于 *sql.DB 与 *sql.Tx。
type queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// lockUser 锁定用户行：同一用户的写入串行执行，保证 change_seq 的提交顺序与取号顺序一致，
// 增量同步不会漏掉变更（设计文档 6.2）。
func lockUser(ctx context.Context, tx *sql.Tx, userID string) error {
	var one int
	err := tx.QueryRowContext(ctx, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, userID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrUserNotFound
	}
	return err
}

type tripRow struct {
	userID   string
	revision int64
	deleted  bool
}

func lockTrip(ctx context.Context, tx *sql.Tx, tripID string) (*tripRow, error) {
	r := &tripRow{}
	var deletedAt sql.NullTime
	err := tx.QueryRowContext(ctx, `SELECT user_id, revision, deleted_at FROM trips WHERE id = $1 FOR UPDATE`, tripID).
		Scan(&r.userID, &r.revision, &deletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.deleted = deletedAt.Valid
	return r, nil
}

func activeTripCount(ctx context.Context, tx *sql.Tx, userID string) (int, error) {
	var n int
	err := tx.QueryRowContext(ctx, `SELECT count(*) FROM trips WHERE user_id = $1 AND deleted_at IS NULL`, userID).Scan(&n)
	return n, err
}

// Put 写入整个行程（新建、更新或恢复墓碑），返回写入后的版本。
func (p *Postgres) Put(ctx context.Context, userID string, b *Bundle, baseRevision int64) (res *Bundle, err error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	if err = lockUser(ctx, tx, userID); err != nil {
		return nil, err
	}
	row, err := lockTrip(ctx, tx, b.Trip.ID)
	if err != nil {
		return nil, err
	}
	t := b.Trip
	switch {
	case row == nil:
		if baseRevision != 0 {
			return nil, ErrNotFound
		}
		if err = checkLimit(ctx, tx, userID); err != nil {
			return nil, err
		}
		_, err = tx.ExecContext(ctx, `
			INSERT INTO trips (id, user_id, title, start_date, end_date, notes, is_sample, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			t.ID, userID, t.Title, nullable(t.StartDate), nullable(t.EndDate), nullable(t.Notes), t.IsSample, t.CreatedAt, t.UpdatedAt)
		if err != nil {
			return nil, mapPgErr(err)
		}
	case row.userID != userID:
		return nil, ErrIDTaken
	case row.revision != baseRevision:
		current, e := loadBundle(ctx, tx, b.Trip.ID)
		if e != nil {
			return nil, e
		}
		// 内容完全相同：是成功写入后响应丢失的重试，直接返回当前版本
		if !current.Deleted && SameContent(current, &Bundle{Trip: b.Trip, Legs: b.Legs, Airports: b.Airports}) {
			_ = tx.Rollback() // 本次没有写入
			return current, nil
		}
		return nil, &ConflictError{Current: current}
	default:
		if row.deleted {
			if err = checkLimit(ctx, tx, userID); err != nil {
				return nil, err
			}
		}
		_, err = tx.ExecContext(ctx, `
			UPDATE trips SET title = $2, start_date = $3, end_date = $4, notes = $5, is_sample = $6,
			  created_at = $7, updated_at = $8, revision = revision + 1, change_seq = nextval('trip_change_seq'),
			  server_updated_at = now(), deleted_at = NULL
			WHERE id = $1`,
			t.ID, t.Title, nullable(t.StartDate), nullable(t.EndDate), nullable(t.Notes), t.IsSample, t.CreatedAt, t.UpdatedAt)
		if err != nil {
			return nil, mapPgErr(err)
		}
		if err = deleteChildren(ctx, tx, t.ID); err != nil {
			return nil, err
		}
	}

	for _, a := range b.Airports {
		_, err = tx.ExecContext(ctx, `
			INSERT INTO trip_airports (trip_id, airport_id, iata, name, name_zh, city, city_zh, aliases, country_code, country_name, latitude, longitude)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
			t.ID, a.ID, a.IATA, a.Name, nullable(a.NameZh), nullable(a.City), nullable(a.CityZh), a.Aliases,
			a.CountryCode, nullable(a.CountryName), a.Latitude, a.Longitude)
		if err != nil {
			return nil, mapPgErr(err)
		}
	}
	for _, l := range b.Legs {
		_, err = tx.ExecContext(ctx, `
			INSERT INTO flight_legs (id, trip_id, ord, departure_airport_id, arrival_airport_id, departure_date,
			  flight_number, airline, notes, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
			l.ID, t.ID, l.Order, l.DepartureAirportID, l.ArrivalAirportID, l.DepartureDate,
			nullable(l.FlightNumber), nullable(l.Airline), nullable(l.Notes), l.CreatedAt, l.UpdatedAt)
		if err != nil {
			return nil, mapPgErr(err)
		}
	}

	if res, err = loadBundle(ctx, tx, t.ID); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return res, nil
}

// Delete 删除行程：清除航段、机场快照与行程内容，只保留墓碑供其他设备同步。
// 已是墓碑且版本一致时幂等返回。
func (p *Postgres) Delete(ctx context.Context, userID, tripID string, baseRevision int64) (res *Bundle, err error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if err = lockUser(ctx, tx, userID); err != nil {
		return nil, err
	}
	row, err := lockTrip(ctx, tx, tripID)
	if err != nil {
		return nil, err
	}
	// 其他用户的行程按「不存在」处理，不泄露其存在
	if row == nil || row.userID != userID {
		return nil, ErrNotFound
	}
	if row.revision != baseRevision {
		current, e := loadBundle(ctx, tx, tripID)
		if e != nil {
			return nil, e
		}
		if current.Deleted {
			// 已被其他设备删除：目标状态已达成
			_ = tx.Rollback()
			return current, nil
		}
		return nil, &ConflictError{Current: current}
	}
	if row.deleted {
		if res, err = loadBundle(ctx, tx, tripID); err != nil {
			return nil, err
		}
		_ = tx.Rollback()
		return res, nil
	}
	if err = deleteChildren(ctx, tx, tripID); err != nil {
		return nil, err
	}
	// 墓碑不保留用户内容（标题有长度约束，用占位值）
	_, err = tx.ExecContext(ctx, `
		UPDATE trips SET title = 'deleted', start_date = NULL, end_date = NULL, notes = NULL, is_sample = false,
		  revision = revision + 1, change_seq = nextval('trip_change_seq'), server_updated_at = now(), deleted_at = now()
		WHERE id = $1`, tripID)
	if err != nil {
		return nil, err
	}
	if res, err = loadBundle(ctx, tx, tripID); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return res, nil
}

// ListChanges 返回 change_seq > afterSeq 的行程（含墓碑），按 change_seq 升序，最多 limit 条。
func (p *Postgres) ListChanges(ctx context.Context, userID string, afterSeq int64, limit int) ([]*Bundle, error) {
	var horizon int64
	err := p.db.QueryRowContext(ctx, `SELECT tombstones_purged_through FROM users WHERE id = $1`, userID).Scan(&horizon)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUserNotFound
	}
	if err != nil {
		return nil, err
	}
	if afterSeq > 0 && afterSeq < horizon {
		return nil, ErrCursorExpired
	}

	rows, err := p.db.QueryContext(ctx, `
		SELECT id FROM trips WHERE user_id = $1 AND change_seq > $2 ORDER BY change_seq LIMIT $3`,
		userID, afterSeq, limit)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return loadBundles(ctx, p.db, ids)
}

// PurgeTombstones 物理删除 deleted_at 早于 olderThan 的墓碑，并提高对应用户的清理水位。
func (p *Postgres) PurgeTombstones(ctx context.Context, olderThan time.Time) (int64, error) {
	var n int64
	err := p.db.QueryRowContext(ctx, `
		WITH purged AS (
		  DELETE FROM trips WHERE deleted_at IS NOT NULL AND deleted_at < $1 RETURNING user_id, change_seq
		), horizon AS (
		  UPDATE users u SET tombstones_purged_through = GREATEST(u.tombstones_purged_through, p.max_seq)
		  FROM (SELECT user_id, max(change_seq) AS max_seq FROM purged GROUP BY user_id) p
		  WHERE u.id = p.user_id
		  RETURNING 1
		)
		SELECT count(*) FROM purged`, olderThan).Scan(&n)
	return n, err
}

func checkLimit(ctx context.Context, tx *sql.Tx, userID string) error {
	n, err := activeTripCount(ctx, tx, userID)
	if err != nil {
		return err
	}
	if n >= MaxActiveTripsPerUser {
		return ErrTripLimit
	}
	return nil
}

func deleteChildren(ctx context.Context, tx *sql.Tx, tripID string) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM flight_legs WHERE trip_id = $1`, tripID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM trip_airports WHERE trip_id = $1`, tripID)
	return err
}

// mapPgErr 把主键冲突（航段 ID 被其他行程占用等）映射为 ErrIDTaken。
func mapPgErr(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" {
		return fmt.Errorf("%w（%s）", ErrIDTaken, pg.ConstraintName)
	}
	return err
}

func loadBundle(ctx context.Context, q queryer, tripID string) (*Bundle, error) {
	bs, err := loadBundles(ctx, q, []string{tripID})
	if err != nil {
		return nil, err
	}
	if len(bs) == 0 {
		return nil, ErrNotFound
	}
	return bs[0], nil
}

// loadBundles 按给定顺序加载多个行程（3 次查询，与行程数量无关）。
func loadBundles(ctx context.Context, q queryer, ids []string) ([]*Bundle, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	byID := make(map[string]*Bundle, len(ids))

	rows, err := q.QueryContext(ctx, `
		SELECT id, title, coalesce(to_char(start_date, 'YYYY-MM-DD'), ''), coalesce(to_char(end_date, 'YYYY-MM-DD'), ''),
		  coalesce(notes, ''), is_sample, created_at, updated_at, revision, change_seq, deleted_at IS NOT NULL
		FROM trips WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		b := &Bundle{}
		t := &b.Trip
		if err := rows.Scan(&t.ID, &t.Title, &t.StartDate, &t.EndDate, &t.Notes, &t.IsSample, &t.CreatedAt, &t.UpdatedAt,
			&b.Revision, &b.ChangeSeq, &b.Deleted); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if b.Deleted {
			// 墓碑只暴露 ID
			b.Trip = Trip{ID: t.ID}
		}
		byID[b.Trip.ID] = b
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = q.QueryContext(ctx, `
		SELECT trip_id, airport_id, iata, name, coalesce(name_zh, ''), coalesce(city, ''), coalesce(city_zh, ''),
		  coalesce(aliases, '{}'), country_code, coalesce(country_name, ''), latitude, longitude
		FROM trip_airports WHERE trip_id = ANY($1) ORDER BY trip_id, airport_id`, ids)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var tripID string
		var a Airport
		if err := rows.Scan(&tripID, &a.ID, &a.IATA, &a.Name, &a.NameZh, &a.City, &a.CityZh, pgTypes.SQLScanner(&a.Aliases),
			&a.CountryCode, &a.CountryName, &a.Latitude, &a.Longitude); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if len(a.Aliases) == 0 {
			a.Aliases = nil
		}
		if b := byID[tripID]; b != nil {
			b.Airports = append(b.Airports, a)
		}
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = q.QueryContext(ctx, `
		SELECT trip_id, id, ord, departure_airport_id, arrival_airport_id, to_char(departure_date, 'YYYY-MM-DD'),
		  coalesce(flight_number, ''), coalesce(airline, ''), coalesce(notes, ''), created_at, updated_at
		FROM flight_legs WHERE trip_id = ANY($1) ORDER BY trip_id, ord`, ids)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var tripID string
		var l Leg
		if err := rows.Scan(&tripID, &l.ID, &l.Order, &l.DepartureAirportID, &l.ArrivalAirportID, &l.DepartureDate,
			&l.FlightNumber, &l.Airline, &l.Notes, &l.CreatedAt, &l.UpdatedAt); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if b := byID[tripID]; b != nil {
			b.Legs = append(b.Legs, l)
		}
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]*Bundle, 0, len(ids))
	for _, id := range ids {
		if b := byID[id]; b != nil {
			out = append(out, b)
		}
	}
	return out, nil
}

package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	neomapv1 "github.com/kongken/NeoMap/server/gen/neomap/v1"
	"github.com/kongken/NeoMap/server/gen/neomap/v1/neomapv1connect"
	"github.com/kongken/NeoMap/server/internal/repo/trip"
	"github.com/kongken/NeoMap/server/internal/repo/user"
	"github.com/kongken/NeoMap/server/internal/testsupport/pgtest"
)

// tripEnv：真实 Postgres（用户与行程）+ miniredis 会话 + 假 OAuth 登录。
type tripEnv struct {
	*flow
	trips *trip.Postgres
}

func newTripEnv(t *testing.T) *tripEnv {
	db := pgtest.New(t)
	trips := trip.NewPostgres(db)
	srv := newTestServerWith(t, serverOpts{users: user.NewPostgres(db), trips: trips})
	return &tripEnv{flow: &flow{t: t, base: srv.URL, env: currentEnv, client: noRedirectClient()}, trips: trips}
}

// loginAs 以指定 GitHub 账号登录，返回该会话的 TripService 客户端。
func (e *tripEnv) loginAs(githubID int) neomapv1connect.TripServiceClient {
	e.t.Helper()
	e.env.oauth.githubUser["id"] = githubID
	c := e.login("code-" + uuid.NewString())
	return e.tripClient(c)
}

func (e *tripEnv) tripClient(c *http.Cookie) neomapv1connect.TripServiceClient {
	jar, _ := cookiejar.New(nil)
	if c != nil {
		jar.SetCookies(mustURL(e.t, e.base), []*http.Cookie{{Name: c.Name, Value: c.Value}})
	}
	return neomapv1connect.NewTripServiceClient(&http.Client{Jar: jar}, e.base)
}

var apiTS = timestamppb.New(time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC))

func protoBundle(id string) *neomapv1.TripBundle {
	return &neomapv1.TripBundle{
		Trip: &neomapv1.Trip{Id: id, Title: "亚洲假期", StartDate: "2026-09-26", EndDate: "2026-10-05", CreatedAt: apiTS, UpdatedAt: apiTS},
		Airports: []*neomapv1.Airport{
			{Id: "oa:5653", Iata: "ICN", Name: "Incheon", NameZh: "仁川国际机场", Aliases: []string{"仁川"}, CountryCode: "KR", Latitude: 37.4691, Longitude: 126.451},
			{Id: "oa:26674", Iata: "HKT", Name: "Phuket", CountryCode: "TH", Latitude: 8.11326, Longitude: 98.3174},
		},
		Legs: []*neomapv1.FlightLeg{
			{Id: uuid.NewString(), Order: 0, DepartureAirportId: "oa:5653", ArrivalAirportId: "oa:26674", DepartureDate: "2026-09-26", FlightNumber: "KE 637", CreatedAt: apiTS, UpdatedAt: apiTS},
			{Id: uuid.NewString(), Order: 1, DepartureAirportId: "oa:26674", ArrivalAirportId: "oa:5653", DepartureDate: "2026-10-02", CreatedAt: apiTS, UpdatedAt: apiTS},
		},
	}
}

func put(c neomapv1connect.TripServiceClient, b *neomapv1.TripBundle, base int64) (*neomapv1.TripBundle, error) {
	res, err := c.PutTrip(context.Background(), connect.NewRequest(&neomapv1.PutTripRequest{Bundle: b, BaseRevision: base}))
	if err != nil {
		return nil, err
	}
	return res.Msg.GetBundle(), nil
}

func code(err error) connect.Code { return connect.CodeOf(err) }

func TestTripAPIRequiresLogin(t *testing.T) {
	e := newTripEnv(t)
	c := e.tripClient(nil)
	ctx := context.Background()
	_, err1 := c.ListChanges(ctx, connect.NewRequest(&neomapv1.ListChangesRequest{}))
	_, err2 := put(c, protoBundle(uuid.NewString()), 0)
	_, err3 := c.DeleteTrip(ctx, connect.NewRequest(&neomapv1.DeleteTripRequest{TripId: uuid.NewString(), BaseRevision: 1}))
	for i, err := range []error{err1, err2, err3} {
		if code(err) != connect.CodeUnauthenticated {
			t.Fatalf("#%d 未登录：%v", i, err)
		}
	}
}

func TestTripAPIValidation(t *testing.T) {
	e := newTripEnv(t)
	c := e.loginAs(1)
	cases := map[string]func(b *neomapv1.TripBundle){
		// protovalidate 字段规则
		"非 UUID 的行程 ID": func(b *neomapv1.TripBundle) { b.Trip.Id = "not-a-uuid" },
		"标题超长":          func(b *neomapv1.TripBundle) { b.Trip.Title = strings.Repeat("长", 81) },
		"日期格式":          func(b *neomapv1.TripBundle) { b.Trip.StartDate = "2026/09/26" },
		"IATA 小写":       func(b *neomapv1.TripBundle) { b.Airports[0].Iata = "icn" },
		"纬度越界":          func(b *neomapv1.TripBundle) { b.Airports[0].Latitude = 91 },
		"缺少时间戳":         func(b *neomapv1.TripBundle) { b.Legs[0].CreatedAt = nil },
		// 服务层跨字段规则
		"标题只有空格":       func(b *neomapv1.TripBundle) { b.Trip.Title = "   " },
		"不存在的日期":       func(b *neomapv1.TripBundle) { b.Legs[0].DepartureDate = "2026-02-30" },
		"结束早于开始":       func(b *neomapv1.TripBundle) { b.Trip.EndDate = "2026-09-01" },
		"引用不存在的机场":     func(b *neomapv1.TripBundle) { b.Legs[0].ArrivalAirportId = "oa:missing" },
		"起终点相同":        func(b *neomapv1.TripBundle) { b.Legs[0].ArrivalAirportId = "oa:5653" },
		"顺序不连续":        func(b *neomapv1.TripBundle) { b.Legs[1].Order = 5 },
		"航段 ID 重复":     func(b *neomapv1.TripBundle) { b.Legs[1].Id = b.Legs[0].Id },
		"机场 ID 重复":     func(b *neomapv1.TripBundle) { b.Airports[1].Id = b.Airports[0].Id },
		"用 PutTrip 删除": func(b *neomapv1.TripBundle) { b.Deleted = true },
	}
	for name, mutate := range cases {
		b := protoBundle(uuid.NewString())
		mutate(b)
		if _, err := put(c, b, 0); code(err) != connect.CodeInvalidArgument {
			t.Errorf("%s：期望 InvalidArgument，得到 %v", name, err)
		}
	}
	// 非法输入没有写入任何数据
	res, err := c.ListChanges(context.Background(), connect.NewRequest(&neomapv1.ListChangesRequest{}))
	if err != nil || len(res.Msg.GetTrips()) != 0 {
		t.Fatalf("非法请求产生了数据：%v %v", res, err)
	}
}

func TestTripAPISyncFlow(t *testing.T) {
	e := newTripEnv(t)
	alice := e.loginAs(100)
	bob := e.loginAs(200)
	ctx := context.Background()

	// 新建 3 个行程
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString()}
	for _, id := range ids {
		got, err := put(alice, protoBundle(id), 0)
		if err != nil || got.GetRevision() != 1 {
			t.Fatalf("新建：%v %v", got, err)
		}
	}

	// 分页拉取：page_size=2 → 2 + 1
	list := func(c neomapv1connect.TripServiceClient, cursor string, size int32) *neomapv1.ListChangesResponse {
		t.Helper()
		res, err := c.ListChanges(ctx, connect.NewRequest(&neomapv1.ListChangesRequest{Cursor: cursor, PageSize: size}))
		if err != nil {
			t.Fatal(err)
		}
		return res.Msg
	}
	p1 := list(alice, "", 2)
	if len(p1.GetTrips()) != 2 || !p1.GetHasMore() {
		t.Fatalf("第一页：%d has_more=%v", len(p1.GetTrips()), p1.GetHasMore())
	}
	p2 := list(alice, p1.GetNextCursor(), 2)
	if len(p2.GetTrips()) != 1 || p2.GetHasMore() || p2.GetTrips()[0].GetTrip().GetId() != ids[2] {
		t.Fatalf("第二页：%+v", p2)
	}
	// 读回的内容完整（含机场别名、航段顺序）
	full := p1.GetTrips()[0]
	if len(full.GetLegs()) != 2 || full.GetLegs()[0].GetFlightNumber() != "KE 637" || len(full.GetAirports()) != 2 {
		t.Fatalf("读回内容：%+v", full)
	}
	// 没有新变更时游标不变
	idle := list(alice, p2.GetNextCursor(), 0)
	if len(idle.GetTrips()) != 0 || idle.GetNextCursor() != p2.GetNextCursor() {
		t.Fatalf("空增量：%+v", idle)
	}

	// 用户隔离：bob 看不到 alice 的行程，也不能占用其 ID
	if got := list(bob, "", 0); len(got.GetTrips()) != 0 {
		t.Fatalf("bob 看到了 %d 个行程", len(got.GetTrips()))
	}
	if _, err := put(bob, protoBundle(ids[0]), 0); code(err) != connect.CodeAlreadyExists {
		t.Fatalf("bob 使用 alice 的行程 ID：%v", err)
	}
	if _, err := bob.DeleteTrip(ctx, connect.NewRequest(&neomapv1.DeleteTripRequest{TripId: ids[0], BaseRevision: 1})); code(err) != connect.CodeNotFound {
		t.Fatalf("bob 删除 alice 的行程：%v", err)
	}

	// 冲突：错误详情附带服务端当前版本
	edited := protoBundle(ids[0])
	edited.Trip.Title = "设备 A 的修改"
	if _, err := put(alice, edited, 1); err != nil {
		t.Fatal(err)
	}
	stale := protoBundle(ids[0])
	stale.Trip.Title = "设备 B 的旧修改"
	_, err := put(alice, stale, 1)
	var cerr *connect.Error
	if !errors.As(err, &cerr) || cerr.Code() != connect.CodeAborted {
		t.Fatalf("冲突：%v", err)
	}
	var current *neomapv1.TripBundle
	for _, d := range cerr.Details() {
		if v, e := d.Value(); e == nil {
			if b, ok := v.(*neomapv1.TripBundle); ok {
				current = b
			}
		}
	}
	if current == nil || current.GetRevision() != 2 || current.GetTrip().GetTitle() != "设备 A 的修改" {
		t.Fatalf("冲突详情：%+v", current)
	}

	// 删除 → 增量里出现只含 ID 的墓碑
	del, err := alice.DeleteTrip(ctx, connect.NewRequest(&neomapv1.DeleteTripRequest{TripId: ids[1], BaseRevision: 1}))
	if err != nil || del.Msg.GetRevision() != 2 {
		t.Fatalf("删除：%v %v", del, err)
	}
	after := list(alice, p2.GetNextCursor(), 0)
	var tomb *neomapv1.TripBundle
	for _, b := range after.GetTrips() {
		if b.GetTrip().GetId() == ids[1] {
			tomb = b
		}
	}
	if tomb == nil || !tomb.GetDeleted() || tomb.GetTrip().GetTitle() != "" || len(tomb.GetLegs()) != 0 {
		t.Fatalf("墓碑：%+v", tomb)
	}

	// 非法游标
	if _, err := alice.ListChanges(ctx, connect.NewRequest(&neomapv1.ListChangesRequest{Cursor: "garbage"})); code(err) != connect.CodeInvalidArgument {
		t.Fatalf("非法游标：%v", err)
	}
	// 墓碑被清理后，旧游标过期
	if _, err := e.trips.PurgeTombstones(ctx, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := alice.ListChanges(ctx, connect.NewRequest(&neomapv1.ListChangesRequest{Cursor: p1.GetNextCursor()})); code(err) != connect.CodeFailedPrecondition {
		t.Fatalf("过期游标：%v", err)
	}
}

func TestTripAPIRequestSizeLimit(t *testing.T) {
	e := newTripEnv(t)
	c := e.loginAs(1)
	b := protoBundle(uuid.NewString())
	// 每个字段都在规则内，但整体约 2 MB，超过 1 MiB 的请求上限
	aliases := make([]string, 50)
	for i := range aliases {
		aliases[i] = strings.Repeat("a", 100)
	}
	for len(b.Airports) < 400 {
		b.Airports = append(b.Airports, &neomapv1.Airport{
			Id: uuid.NewString(), Iata: "AAA", Name: "x", CountryCode: "XX", Aliases: aliases,
		})
	}
	if _, err := put(c, b, 0); code(err) != connect.CodeResourceExhausted {
		t.Fatalf("超大请求：%v", err)
	}
}

// Package trip 存储与同步行程（假期 + 航段 + 机场快照）。
// 同步协议见 docs/backend-phase1-design.md 第 6 节。
package trip

import (
	"errors"
	"slices"
	"time"
)

// MaxActiveTripsPerUser 每个用户未删除的行程上限。
const MaxActiveTripsPerUser = 500

var (
	ErrNotFound      = errors.New("行程不存在")
	ErrIDTaken       = errors.New("行程或航段 ID 已被占用")
	ErrTripLimit     = errors.New("行程数量已达上限")
	ErrCursorExpired = errors.New("同步游标已过期，需要全量同步")
	ErrUserNotFound  = errors.New("用户不存在")
)

// ConflictError 表示客户端的 base_revision 与服务端不一致，Current 为服务端当前版本。
type ConflictError struct{ Current *Bundle }

func (e *ConflictError) Error() string { return "行程已在其他设备上修改" }

type Trip struct {
	ID        string
	Title     string
	StartDate string // YYYY-MM-DD 或空
	EndDate   string
	Notes     string
	IsSample  bool
	CreatedAt time.Time
	UpdatedAt time.Time
}

type Leg struct {
	ID                 string
	Order              int
	DepartureAirportID string
	ArrivalAirportID   string
	DepartureDate      string
	FlightNumber       string
	Airline            string
	Notes              string
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

type Airport struct {
	ID          string
	IATA        string
	Name        string
	NameZh      string
	City        string
	CityZh      string
	Aliases     []string
	CountryCode string
	CountryName string
	Latitude    float64
	Longitude   float64
}

type Bundle struct {
	Trip     Trip
	Legs     []Leg     // 按 Order 升序
	Airports []Airport // 按 ID 升序
	Revision int64
	Deleted  bool
	// ChangeSeq 是最后一次变更的序号（同步游标）
	ChangeSeq int64
}

// SameContent 判断两个行程内容是否相同（忽略版本与变更序号）。
// 用于识别「请求已成功但响应丢失后的重试」，避免把重试误判为冲突。
func SameContent(a, b *Bundle) bool {
	if a.Deleted != b.Deleted || !sameTrip(a.Trip, b.Trip) || len(a.Legs) != len(b.Legs) || len(a.Airports) != len(b.Airports) {
		return false
	}
	al, bl := sortedLegs(a.Legs), sortedLegs(b.Legs)
	for i := range al {
		if !sameLeg(al[i], bl[i]) {
			return false
		}
	}
	aa, ba := sortedAirports(a.Airports), sortedAirports(b.Airports)
	for i := range aa {
		if !sameAirport(aa[i], ba[i]) {
			return false
		}
	}
	return true
}

func sameTrip(a, b Trip) bool {
	return a.ID == b.ID && a.Title == b.Title && a.StartDate == b.StartDate && a.EndDate == b.EndDate &&
		a.Notes == b.Notes && a.IsSample == b.IsSample && a.CreatedAt.Equal(b.CreatedAt) && a.UpdatedAt.Equal(b.UpdatedAt)
}

func sameLeg(a, b Leg) bool {
	return a.ID == b.ID && a.Order == b.Order && a.DepartureAirportID == b.DepartureAirportID &&
		a.ArrivalAirportID == b.ArrivalAirportID && a.DepartureDate == b.DepartureDate &&
		a.FlightNumber == b.FlightNumber && a.Airline == b.Airline && a.Notes == b.Notes &&
		a.CreatedAt.Equal(b.CreatedAt) && a.UpdatedAt.Equal(b.UpdatedAt)
}

func sameAirport(a, b Airport) bool {
	return a.ID == b.ID && a.IATA == b.IATA && a.Name == b.Name && a.NameZh == b.NameZh && a.City == b.City &&
		a.CityZh == b.CityZh && slices.Equal(a.Aliases, b.Aliases) && a.CountryCode == b.CountryCode &&
		a.CountryName == b.CountryName && a.Latitude == b.Latitude && a.Longitude == b.Longitude
}

func sortedLegs(l []Leg) []Leg {
	out := slices.Clone(l)
	slices.SortFunc(out, func(x, y Leg) int { return x.Order - y.Order })
	return out
}

func sortedAirports(a []Airport) []Airport {
	out := slices.Clone(a)
	slices.SortFunc(out, func(x, y Airport) int {
		switch {
		case x.ID < y.ID:
			return -1
		case x.ID > y.ID:
			return 1
		}
		return 0
	})
	return out
}

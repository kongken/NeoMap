package application

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	neomapv1 "github.com/kongken/NeoMap/server/gen/neomap/v1"
	"github.com/kongken/NeoMap/server/internal/repo/trip"
)

// ---- proto → 领域对象 ----

func bundleFromProto(p *neomapv1.TripBundle) *trip.Bundle {
	t := p.GetTrip()
	b := &trip.Bundle{Trip: trip.Trip{
		ID:        t.GetId(),
		Title:     strings.TrimSpace(t.GetTitle()),
		StartDate: t.GetStartDate(),
		EndDate:   t.GetEndDate(),
		Notes:     strings.TrimSpace(t.GetNotes()),
		IsSample:  t.GetIsSample(),
		CreatedAt: t.GetCreatedAt().AsTime(),
		UpdatedAt: t.GetUpdatedAt().AsTime(),
	}}
	for _, l := range p.GetLegs() {
		b.Legs = append(b.Legs, trip.Leg{
			ID:                 l.GetId(),
			Order:              int(l.GetOrder()),
			DepartureAirportID: l.GetDepartureAirportId(),
			ArrivalAirportID:   l.GetArrivalAirportId(),
			DepartureDate:      l.GetDepartureDate(),
			FlightNumber:       strings.TrimSpace(l.GetFlightNumber()),
			Airline:            strings.TrimSpace(l.GetAirline()),
			Notes:              strings.TrimSpace(l.GetNotes()),
			CreatedAt:          l.GetCreatedAt().AsTime(),
			UpdatedAt:          l.GetUpdatedAt().AsTime(),
		})
	}
	for _, a := range p.GetAirports() {
		var aliases []string
		if len(a.GetAliases()) > 0 {
			aliases = append(aliases, a.GetAliases()...)
		}
		b.Airports = append(b.Airports, trip.Airport{
			ID:          a.GetId(),
			IATA:        a.GetIata(),
			Name:        a.GetName(),
			NameZh:      a.GetNameZh(),
			City:        a.GetCity(),
			CityZh:      a.GetCityZh(),
			Aliases:     aliases,
			CountryCode: a.GetCountryCode(),
			CountryName: a.GetCountryName(),
			Latitude:    a.GetLatitude(),
			Longitude:   a.GetLongitude(),
		})
	}
	return b
}

// ---- 领域对象 → proto ----

func bundleToProto(b *trip.Bundle) *neomapv1.TripBundle {
	if b.Deleted {
		return &neomapv1.TripBundle{Trip: &neomapv1.Trip{Id: b.Trip.ID}, Revision: b.Revision, Deleted: true}
	}
	t := b.Trip
	p := &neomapv1.TripBundle{
		Trip: &neomapv1.Trip{
			Id: t.ID, Title: t.Title, StartDate: t.StartDate, EndDate: t.EndDate, Notes: t.Notes, IsSample: t.IsSample,
			CreatedAt: timestamppb.New(t.CreatedAt), UpdatedAt: timestamppb.New(t.UpdatedAt),
		},
		Revision: b.Revision,
	}
	for _, l := range b.Legs {
		p.Legs = append(p.Legs, &neomapv1.FlightLeg{
			Id: l.ID, Order: int32(l.Order), DepartureAirportId: l.DepartureAirportID, ArrivalAirportId: l.ArrivalAirportID,
			DepartureDate: l.DepartureDate, FlightNumber: l.FlightNumber, Airline: l.Airline, Notes: l.Notes,
			CreatedAt: timestamppb.New(l.CreatedAt), UpdatedAt: timestamppb.New(l.UpdatedAt),
		})
	}
	for _, a := range b.Airports {
		p.Airports = append(p.Airports, &neomapv1.Airport{
			Id: a.ID, Iata: a.IATA, Name: a.Name, NameZh: a.NameZh, City: a.City, CityZh: a.CityZh, Aliases: a.Aliases,
			CountryCode: a.CountryCode, CountryName: a.CountryName, Latitude: a.Latitude, Longitude: a.Longitude,
		})
	}
	return p
}

// ---- 跨字段校验（字段级规则由 protovalidate 在拦截器中完成） ----

func validDate(s string) bool {
	if len(s) != 10 {
		return false
	}
	_, err := time.Parse(time.DateOnly, s)
	return err == nil
}

// validateBundle 检查 protovalidate 无法表达的规则。
func validateBundle(b *trip.Bundle) error {
	t := b.Trip
	if t.Title == "" {
		return fmt.Errorf("trip.title 不能为空")
	}
	if t.StartDate != "" && !validDate(t.StartDate) {
		return fmt.Errorf("trip.start_date 不是有效日期：%s", t.StartDate)
	}
	if t.EndDate != "" && !validDate(t.EndDate) {
		return fmt.Errorf("trip.end_date 不是有效日期：%s", t.EndDate)
	}
	if t.StartDate != "" && t.EndDate != "" && t.EndDate < t.StartDate {
		return fmt.Errorf("trip.end_date 早于 start_date")
	}

	airports := make(map[string]trip.Airport, len(b.Airports))
	for _, a := range b.Airports {
		if _, dup := airports[a.ID]; dup {
			return fmt.Errorf("机场 ID 重复：%s", a.ID)
		}
		airports[a.ID] = a
	}
	legIDs := make(map[string]bool, len(b.Legs))
	orders := make([]bool, len(b.Legs))
	for _, l := range b.Legs {
		if legIDs[l.ID] {
			return fmt.Errorf("航段 ID 重复：%s", l.ID)
		}
		legIDs[l.ID] = true
		if l.Order < 0 || l.Order >= len(b.Legs) || orders[l.Order] {
			return fmt.Errorf("航段顺序必须从 0 开始连续且不重复")
		}
		orders[l.Order] = true
		if !validDate(l.DepartureDate) {
			return fmt.Errorf("航段 %s 的出发日期无效：%s", l.ID, l.DepartureDate)
		}
		dep, okDep := airports[l.DepartureAirportID]
		arr, okArr := airports[l.ArrivalAirportID]
		if !okDep || !okArr {
			return fmt.Errorf("航段 %s 引用了不存在的机场快照", l.ID)
		}
		if dep.IATA == arr.IATA {
			return fmt.Errorf("航段 %s 的出发和到达机场相同", l.ID)
		}
	}
	return nil
}

// ---- 同步游标 ----

const cursorPrefix = "c1."

func encodeCursor(seq int64) string { return cursorPrefix + strconv.FormatInt(seq, 10) }

func decodeCursor(s string) (int64, error) {
	if s == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(strings.TrimPrefix(s, cursorPrefix), 10, 64)
	if !strings.HasPrefix(s, cursorPrefix) || err != nil || n < 0 {
		return 0, fmt.Errorf("无效的同步游标")
	}
	return n, nil
}

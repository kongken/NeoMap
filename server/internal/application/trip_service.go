package application

import (
	"context"
	"errors"
	"log/slog"

	"connectrpc.com/connect"

	neomapv1 "github.com/kongken/NeoMap/server/gen/neomap/v1"
	"github.com/kongken/NeoMap/server/gen/neomap/v1/neomapv1connect"
	"github.com/kongken/NeoMap/server/internal/auth"
	"github.com/kongken/NeoMap/server/internal/repo/trip"
)

const (
	defaultPageSize = 100
	maxPageSize     = 500
)

// TripRepository 是 TripService 依赖的存储接口。
type TripRepository interface {
	Put(ctx context.Context, userID string, b *trip.Bundle, baseRevision int64) (*trip.Bundle, error)
	Delete(ctx context.Context, userID, tripID string, baseRevision int64) (*trip.Bundle, error)
	ListChanges(ctx context.Context, userID string, afterSeq int64, limit int) ([]*trip.Bundle, error)
}

type TripService struct{ trips TripRepository }

var _ neomapv1connect.TripServiceHandler = (*TripService)(nil)

func NewTripService(trips TripRepository) *TripService { return &TripService{trips: trips} }

// requireUser 返回当前登录用户 ID；未登录返回 Unauthenticated。
func requireUser(ctx context.Context) (string, error) {
	p := auth.FromContext(ctx)
	if p == nil {
		return "", connect.NewError(connect.CodeUnauthenticated, errors.New("请先登录"))
	}
	return p.UserID, nil
}

func (s *TripService) ListChanges(ctx context.Context, req *connect.Request[neomapv1.ListChangesRequest]) (*connect.Response[neomapv1.ListChangesResponse], error) {
	userID, err := requireUser(ctx)
	if err != nil {
		return nil, err
	}
	after, err := decodeCursor(req.Msg.GetCursor())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	size := int(req.Msg.GetPageSize())
	if size <= 0 {
		size = defaultPageSize
	}
	size = min(size, maxPageSize)

	// 多取一条判断是否还有下一页
	list, err := s.trips.ListChanges(ctx, userID, after, size+1)
	if err != nil {
		return nil, mapTripErr(err, "ListChanges", userID)
	}
	res := &neomapv1.ListChangesResponse{NextCursor: encodeCursor(after)}
	if len(list) > size {
		list = list[:size]
		res.HasMore = true
	}
	for _, b := range list {
		res.Trips = append(res.Trips, bundleToProto(b))
		res.NextCursor = encodeCursor(b.ChangeSeq)
	}
	return connect.NewResponse(res), nil
}

func (s *TripService) PutTrip(ctx context.Context, req *connect.Request[neomapv1.PutTripRequest]) (*connect.Response[neomapv1.PutTripResponse], error) {
	userID, err := requireUser(ctx)
	if err != nil {
		return nil, err
	}
	if req.Msg.GetBundle().GetDeleted() {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("删除请使用 DeleteTrip"))
	}
	b := bundleFromProto(req.Msg.GetBundle())
	if err := validateBundle(b); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	saved, err := s.trips.Put(ctx, userID, b, req.Msg.GetBaseRevision())
	if err != nil {
		return nil, mapTripErr(err, "PutTrip", userID)
	}
	return connect.NewResponse(&neomapv1.PutTripResponse{Bundle: bundleToProto(saved)}), nil
}

func (s *TripService) DeleteTrip(ctx context.Context, req *connect.Request[neomapv1.DeleteTripRequest]) (*connect.Response[neomapv1.DeleteTripResponse], error) {
	userID, err := requireUser(ctx)
	if err != nil {
		return nil, err
	}
	tomb, err := s.trips.Delete(ctx, userID, req.Msg.GetTripId(), req.Msg.GetBaseRevision())
	if err != nil {
		return nil, mapTripErr(err, "DeleteTrip", userID)
	}
	return connect.NewResponse(&neomapv1.DeleteTripResponse{Revision: tomb.Revision}), nil
}

// mapTripErr 把存储层错误映射为 Connect 错误码；冲突时在错误详情中附带服务端当前版本。
func mapTripErr(err error, op, userID string) error {
	var conflict *trip.ConflictError
	switch {
	case errors.As(err, &conflict):
		cerr := connect.NewError(connect.CodeAborted, errors.New("行程已在其他设备上修改"))
		if detail, e := connect.NewErrorDetail(bundleToProto(conflict.Current)); e == nil {
			cerr.AddDetail(detail)
		}
		return cerr
	case errors.Is(err, trip.ErrNotFound):
		return connect.NewError(connect.CodeNotFound, err)
	case errors.Is(err, trip.ErrIDTaken):
		return connect.NewError(connect.CodeAlreadyExists, trip.ErrIDTaken)
	case errors.Is(err, trip.ErrTripLimit):
		return connect.NewError(connect.CodeResourceExhausted, err)
	case errors.Is(err, trip.ErrCursorExpired):
		return connect.NewError(connect.CodeFailedPrecondition, err)
	case errors.Is(err, trip.ErrUserNotFound):
		// 会话指向已删除的用户
		return connect.NewError(connect.CodeUnauthenticated, errors.New("请重新登录"))
	}
	slog.Error("trip operation failed", "op", op, "user_id", userID, "error", err)
	return connect.NewError(connect.CodeInternal, errors.New("服务暂时不可用，请稍后重试"))
}

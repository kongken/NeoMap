// Package application 实现 ConnectRPC 服务。
package application

import (
	"context"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	neomapv1 "github.com/kongken/NeoMap/server/gen/neomap/v1"
	"github.com/kongken/NeoMap/server/gen/neomap/v1/neomapv1connect"
)

// BuildInfo 由 main 通过 -ldflags 注入。
type BuildInfo struct {
	Service string
	Version string
	Commit  string
}

type SystemService struct {
	info BuildInfo
	now  func() time.Time
}

var _ neomapv1connect.SystemServiceHandler = (*SystemService)(nil)

func NewSystemService(info BuildInfo) *SystemService {
	return &SystemService{info: info, now: time.Now}
}

func (s *SystemService) GetServerInfo(_ context.Context, _ *connect.Request[neomapv1.GetServerInfoRequest]) (*connect.Response[neomapv1.GetServerInfoResponse], error) {
	return connect.NewResponse(&neomapv1.GetServerInfoResponse{
		Service:    s.info.Service,
		Version:    s.info.Version,
		Commit:     s.info.Commit,
		ServerTime: timestamppb.New(s.now()),
	}), nil
}

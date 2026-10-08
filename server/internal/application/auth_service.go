package application

import (
	"context"
	"errors"
	"log/slog"

	"connectrpc.com/connect"

	neomapv1 "github.com/kongken/NeoMap/server/gen/neomap/v1"
	"github.com/kongken/NeoMap/server/gen/neomap/v1/neomapv1connect"
	"github.com/kongken/NeoMap/server/internal/auth"
	"github.com/kongken/NeoMap/server/internal/repo/user"
)

type AuthService struct {
	auth  *auth.Service
	users user.Repository
}

var _ neomapv1connect.AuthServiceHandler = (*AuthService)(nil)

func NewAuthService(a *auth.Service, users user.Repository) *AuthService {
	return &AuthService{auth: a, users: users}
}

func (s *AuthService) GetMe(ctx context.Context, _ *connect.Request[neomapv1.GetMeRequest]) (*connect.Response[neomapv1.GetMeResponse], error) {
	p := auth.FromContext(ctx)
	if p == nil {
		return connect.NewResponse(&neomapv1.GetMeResponse{}), nil
	}
	u, err := s.users.Get(ctx, p.UserID)
	if errors.Is(err, user.ErrNotFound) {
		// 会话指向已删除的用户：视为未登录
		return connect.NewResponse(&neomapv1.GetMeResponse{}), nil
	}
	if err != nil {
		slog.Error("get user failed", "user_id", p.UserID, "error", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("读取用户失败"))
	}
	return connect.NewResponse(&neomapv1.GetMeResponse{User: &neomapv1.User{
		Id:          u.ID,
		DisplayName: u.DisplayName,
		Email:       u.Email,
		AvatarUrl:   u.AvatarURL,
		Provider:    p.Session.Provider,
	}}), nil
}

func (s *AuthService) ListProviders(context.Context, *connect.Request[neomapv1.ListProvidersRequest]) (*connect.Response[neomapv1.ListProvidersResponse], error) {
	res := &neomapv1.ListProvidersResponse{}
	for _, p := range s.auth.Providers.List() {
		res.Providers = append(res.Providers, &neomapv1.Provider{Name: p.Name(), DisplayName: p.DisplayName()})
	}
	return connect.NewResponse(res), nil
}

func (s *AuthService) Logout(ctx context.Context, req *connect.Request[neomapv1.LogoutRequest]) (*connect.Response[neomapv1.LogoutResponse], error) {
	res := connect.NewResponse(&neomapv1.LogoutResponse{})
	res.Header().Add("Set-Cookie", s.auth.ClearCookie().String())
	p := auth.FromContext(ctx)
	if p == nil {
		return res, nil
	}
	var err error
	if req.Msg.GetAllDevices() {
		err = s.auth.Sessions.RevokeAll(ctx, p.UserID)
	} else {
		err = s.auth.Sessions.Revoke(ctx, p.Session)
	}
	if err != nil {
		slog.Error("revoke session failed", "user_id", p.UserID, "error", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("退出登录失败，请重试"))
	}
	return res, nil
}

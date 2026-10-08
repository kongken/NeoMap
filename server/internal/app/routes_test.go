package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/gin-gonic/gin"

	neomapv1 "github.com/kongken/NeoMap/server/gen/neomap/v1"
	"github.com/kongken/NeoMap/server/gen/neomap/v1/neomapv1connect"
	"github.com/kongken/NeoMap/server/internal/application"
	"github.com/kongken/NeoMap/server/internal/health"
	"github.com/kongken/NeoMap/server/internal/repo/user"
)

const allowedOrigin = "https://app.example.com"

type serverOpts struct {
	redisErr error
	users    user.Repository // 为空时使用内存实现
	trips    application.TripRepository
}

func newTestServer(t *testing.T, redisErr error) *httptest.Server {
	return newTestServerWith(t, serverOpts{redisErr: redisErr})
}

func newTestServerWith(t *testing.T, o serverOpts) *httptest.Server {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	redisErr := o.redisErr
	authSvc, users := newTestAuth(t, o.users)
	if err := Register(r, &Deps{
		Build: application.BuildInfo{Service: "neomap-api", Version: "v1.2.3", Commit: "abc123"},
		Health: health.NewHandler(map[string]health.Checker{
			"postgres": func(context.Context) error { return nil },
			"redis":    func(context.Context) error { return redisErr },
		}, time.Second),
		AllowedOrigins: []string{allowedOrigin},
		Auth:           authSvc,
		Users:          users,
		Trips:          o.trips,
	}); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv
}

func TestGetServerInfo(t *testing.T) {
	srv := newTestServer(t, nil)
	client := neomapv1connect.NewSystemServiceClient(srv.Client(), srv.URL)
	res, err := client.GetServerInfo(context.Background(), connect.NewRequest(&neomapv1.GetServerInfoRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if res.Msg.GetService() != "neomap-api" || res.Msg.GetVersion() != "v1.2.3" || res.Msg.GetCommit() != "abc123" {
		t.Fatalf("unexpected info: %+v", res.Msg)
	}
	if d := time.Since(res.Msg.GetServerTime().AsTime()); d < 0 || d > time.Minute {
		t.Fatalf("server_time off by %v", d)
	}
}

func TestHealthz(t *testing.T) {
	ok := newTestServer(t, nil)
	res, err := http.Get(ok.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("healthy: got %d", res.StatusCode)
	}

	bad := newTestServer(t, errors.New("down"))
	res, err = http.Get(bad.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("redis down: got %d, want 503", res.StatusCode)
	}

	// /ping 不检查依赖
	res, err = http.Get(bad.URL + "/ping")
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("ping: got %d", res.StatusCode)
	}
}

func preflight(t *testing.T, url, origin string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodOptions, url+"/neomap.v1.SystemService/GetServerInfo", nil)
	req.Header.Set("Origin", origin)
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	// 浏览器按 Fetch 规范发送小写、排序后的列表；rs/cors 依赖这一格式
	req.Header.Set("Access-Control-Request-Headers", "connect-protocol-version,content-type")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	return res
}

func TestCORS(t *testing.T) {
	srv := newTestServer(t, nil)

	res := preflight(t, srv.URL, allowedOrigin)
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != allowedOrigin {
		t.Fatalf("allowed origin: Access-Control-Allow-Origin = %q", got)
	}
	if res.Header.Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatal("allowed origin: credentials not allowed")
	}

	res = preflight(t, srv.URL, "https://evil.example")
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("disallowed origin got Access-Control-Allow-Origin = %q", got)
	}
}

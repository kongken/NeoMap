package app

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/kongken/NeoMap/server/internal/auth"
	"github.com/kongken/NeoMap/server/internal/auth/oauthstate"
	"github.com/kongken/NeoMap/server/internal/auth/session"
	"github.com/kongken/NeoMap/server/internal/config"
	"github.com/kongken/NeoMap/server/internal/ratelimit"
	"github.com/kongken/NeoMap/server/internal/repo/user"
)

const (
	testAppBase = "https://app.example.com"
	testAPIBase = "https://api.example.com"
)

// fakeOAuth 模拟 GitHub / Google 的令牌与用户信息端点，并校验 PKCE。
type fakeOAuth struct {
	srv *httptest.Server

	mu         sync.Mutex
	challenges map[string]string // code → code_challenge（由测试在授权跳转后登记）
	// 可调整的用户资料
	githubUser   map[string]any
	githubEmails []map[string]any
	googleUser   map[string]any
}

func newFakeOAuth(t *testing.T) *fakeOAuth {
	f := &fakeOAuth{
		challenges: map[string]string{},
		githubUser: map[string]any{"id": 4242, "login": "octo", "name": "Octo Cat", "avatar_url": "https://avatars.example/octo"},
		githubEmails: []map[string]any{
			{"email": "unverified@example.com", "primary": false, "verified": false},
			{"email": "octo@example.com", "primary": true, "verified": true},
		},
		googleUser: map[string]any{"sub": "g-123", "name": "Gina", "email": "gina@example.com", "email_verified": true, "picture": "https://pics.example/g"},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/token", f.token)
	mux.HandleFunc("/github/user", f.json(func() any { return f.githubUser }))
	mux.HandleFunc("/github/emails", f.json(func() any { return f.githubEmails }))
	mux.HandleFunc("/google/userinfo", f.json(func() any { return f.googleUser }))
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeOAuth) allowCode(code, challenge string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.challenges[code] = challenge
}

func (f *fakeOAuth) token(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	f.mu.Lock()
	challenge, ok := f.challenges[r.Form.Get("code")]
	delete(f.challenges, r.Form.Get("code"))
	f.mu.Unlock()
	sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
	if !ok || base64.RawURLEncoding.EncodeToString(sum[:]) != challenge {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "at-" + r.Form.Get("code"), "token_type": "bearer"})
}

func (f *fakeOAuth) json(body func() any) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		f.mu.Lock()
		b := body()
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(b)
	}
}

type testAuthEnv struct {
	mr    *miniredis.Miniredis
	oauth *fakeOAuth
	users *user.Memory
	svc   *auth.Service
}

var currentEnv *testAuthEnv

// newTestAuth 组装使用 miniredis、内存用户仓储与假 OAuth 服务的 auth.Service。
func newTestAuth(t *testing.T) (*auth.Service, user.Repository) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	f := newFakeOAuth(t)
	cfg := config.NeoMapConfig{Auth: config.AuthConfig{
		AppBaseURL:              testAppBase,
		APIBaseURL:              testAPIBase,
		LoginRateLimitPerMinute: 5,
		Providers: config.ProvidersConfig{
			GitHub: config.OAuthProviderConfig{ClientID: "gh-id", ClientSecret: "gh-secret",
				AuthURL: "https://github.example/authorize", TokenURL: f.srv.URL + "/token",
				UserInfoURL: f.srv.URL + "/github/user", EmailsURL: f.srv.URL + "/github/emails"},
			Google: config.OAuthProviderConfig{ClientID: "g-id", ClientSecret: "g-secret",
				AuthURL: "https://google.example/authorize", TokenURL: f.srv.URL + "/token",
				UserInfoURL: f.srv.URL + "/google/userinfo"},
		},
	}}.WithDefaults()
	users := user.NewMemory()
	svc := auth.NewService(cfg.Auth, []string{allowedOrigin}, auth.BuildProviders(cfg.Auth),
		session.NewStore(rdb, cfg.Auth.SessionTTL, cfg.Auth.SessionRenewBefore),
		oauthstate.NewStore(rdb), users, ratelimit.New(rdb))
	currentEnv = &testAuthEnv{mr: mr, oauth: f, users: users, svc: svc}
	return svc, users
}

// noRedirectClient 不跟随跳转，便于检查 Location 与 Set-Cookie。
func noRedirectClient() *http.Client {
	return &http.Client{
		Timeout:       10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

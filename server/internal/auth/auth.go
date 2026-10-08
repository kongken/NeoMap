// Package auth 实现 OAuth 登录跳转、会话 Cookie 与请求认证。
package auth

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/kongken/NeoMap/server/internal/auth/oauthstate"
	"github.com/kongken/NeoMap/server/internal/auth/provider"
	"github.com/kongken/NeoMap/server/internal/auth/session"
	"github.com/kongken/NeoMap/server/internal/config"
	"github.com/kongken/NeoMap/server/internal/ratelimit"
	"github.com/kongken/NeoMap/server/internal/repo/user"
)

// Principal 是已认证的调用方，由 Middleware 放入请求 context。
type Principal struct {
	UserID  string
	Session *session.Session
}

type principalKey struct{}

func WithPrincipal(ctx context.Context, p *Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}

// FromContext 返回当前调用方；未登录时为 nil。
func FromContext(ctx context.Context) *Principal {
	p, _ := ctx.Value(principalKey{}).(*Principal)
	return p
}

type Service struct {
	cfg       config.AuthConfig
	origins   []string
	Providers *provider.Registry
	Sessions  *session.Store
	states    *oauthstate.Store
	users     user.Repository
	limiter   *ratelimit.Limiter
}

func NewService(cfg config.AuthConfig, allowedOrigins []string, providers *provider.Registry, sessions *session.Store, states *oauthstate.Store, users user.Repository, limiter *ratelimit.Limiter) *Service {
	return &Service{cfg: cfg, origins: allowedOrigins, Providers: providers, Sessions: sessions, states: states, users: users, limiter: limiter}
}

// BuildProviders 按配置创建已启用的登录方式（GitHub 在前）。
func BuildProviders(c config.AuthConfig) *provider.Registry {
	redirect := func(p config.OAuthProviderConfig, name string) string {
		if p.RedirectURL != "" {
			return p.RedirectURL
		}
		return strings.TrimRight(c.APIBaseURL, "/") + "/auth/oauth/" + name + "/callback"
	}
	var list []provider.Provider
	if gh := c.Providers.GitHub; gh.Enabled() {
		list = append(list, provider.NewGitHub(provider.GitHubConfig{
			ClientID: gh.ClientID, ClientSecret: gh.ClientSecret, RedirectURL: redirect(gh, "github"),
			AuthURL: gh.AuthURL, TokenURL: gh.TokenURL, UserURL: gh.UserInfoURL, EmailsURL: gh.EmailsURL,
		}))
	}
	if g := c.Providers.Google; g.Enabled() {
		list = append(list, provider.NewGoogle(provider.GoogleConfig{
			ClientID: g.ClientID, ClientSecret: g.ClientSecret, RedirectURL: redirect(g, "google"),
			AuthURL: g.AuthURL, TokenURL: g.TokenURL, UserInfoURL: g.UserInfoURL,
		}))
	}
	return provider.NewRegistry(list...)
}

// ---- Cookie ----

func (s *Service) cookie(value string, maxAge time.Duration) *http.Cookie {
	c := &http.Cookie{
		Name:     s.cfg.Cookie.Name,
		Value:    value,
		Path:     "/",
		Domain:   s.cfg.Cookie.Domain,
		HttpOnly: true,
		Secure:   !s.cfg.Cookie.Insecure,
		SameSite: http.SameSiteLaxMode,
	}
	if maxAge > 0 {
		c.MaxAge = int(maxAge / time.Second)
		c.Expires = time.Now().Add(maxAge)
	} else {
		c.MaxAge = -1
		c.Expires = time.Unix(0, 0)
	}
	return c
}

// SessionCookie 返回写入会话令牌的 Cookie。
func (s *Service) SessionCookie(token string) *http.Cookie { return s.cookie(token, s.Sessions.TTL()) }

// ClearCookie 返回删除会话 Cookie 的 Set-Cookie。
func (s *Service) ClearCookie() *http.Cookie { return s.cookie("", 0) }

// ---- 中间件 ----

// Middleware 读取会话 Cookie，把 Principal 放入请求 context。
// 会话无效时清除 Cookie；会话被续期时刷新 Cookie 有效期。
func (s *Service) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		ck, err := c.Request.Cookie(s.cfg.Cookie.Name)
		if err != nil || ck.Value == "" {
			c.Next()
			return
		}
		sess, renewed, err := s.Sessions.Lookup(c.Request.Context(), ck.Value)
		switch {
		case errors.Is(err, session.ErrNotFound):
			http.SetCookie(c.Writer, s.ClearCookie())
		case err != nil:
			// Redis 故障：按未登录处理，不清除 Cookie，恢复后会话仍有效
			slog.Warn("session lookup failed", "error", err)
		default:
			if renewed {
				http.SetCookie(c.Writer, s.SessionCookie(ck.Value))
			}
			c.Request = c.Request.WithContext(WithPrincipal(c.Request.Context(), &Principal{UserID: sess.UserID, Session: sess}))
		}
		c.Next()
	}
}

// RequireAllowedOrigin 是 CSRF 防护：写请求若带 Origin 头（浏览器跨源请求一定会带），
// 必须在白名单内。不带 Origin 的请求（curl、服务端调用）不会携带浏览器 Cookie，放行。
func (s *Service) RequireAllowedOrigin() gin.HandlerFunc {
	return func(c *gin.Context) {
		switch c.Request.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			c.Next()
			return
		}
		origin := c.GetHeader("Origin")
		if origin != "" && !slices.Contains(s.origins, origin) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "origin not allowed"})
			return
		}
		c.Next()
	}
}

// ---- OAuth 跳转 ----

// 登录结果通过查询参数告诉前端：login=success 或 login_error=<原因>。
const (
	loginErrInvalidState = "invalid_state"
	loginErrCancelled    = "cancelled"
	loginErrFailed       = "failed"
	loginErrRateLimited  = "rate_limited"
	loginErrUnknown      = "unknown_provider"
)

// SafeReturnTo 只允许站内相对路径，防止开放重定向。
func SafeReturnTo(raw string) string {
	if raw == "" || len(raw) > 512 || !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") ||
		strings.ContainsAny(raw, "\\\r\n\t") {
		return "/"
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "" || u.Host != "" {
		return "/"
	}
	return raw
}

// appURL 拼出前端地址，并附加登录结果参数。
func (s *Service) appURL(returnTo, key, value string) string {
	u, err := url.Parse(SafeReturnTo(returnTo))
	if err != nil {
		u = &url.URL{Path: "/"}
	}
	q := u.Query()
	q.Del("login")
	q.Del("login_error")
	q.Set(key, value)
	u.RawQuery = q.Encode()
	return strings.TrimRight(s.cfg.AppBaseURL, "/") + u.String()
}

// Start 处理 GET /auth/oauth/:provider/start?return_to=/path
func (s *Service) Start(c *gin.Context) {
	returnTo := SafeReturnTo(c.Query("return_to"))
	p, err := s.Providers.Get(c.Param("provider"))
	if err != nil {
		c.Redirect(http.StatusFound, s.appURL(returnTo, "login_error", loginErrUnknown))
		return
	}
	ctx := c.Request.Context()
	limit := s.cfg.LoginRateLimitPerMinute
	if ok, err := s.limiter.Allow(ctx, "login:"+c.ClientIP(), limit, time.Minute); err != nil || !ok {
		if err != nil {
			slog.Error("login rate limit check failed", "error", err)
			c.Redirect(http.StatusFound, s.appURL(returnTo, "login_error", loginErrFailed))
			return
		}
		c.Redirect(http.StatusFound, s.appURL(returnTo, "login_error", loginErrRateLimited))
		return
	}
	verifier := provider.GenerateVerifier()
	state, err := s.states.Create(ctx, oauthstate.Entry{Provider: p.Name(), Verifier: verifier, ReturnTo: returnTo})
	if err != nil {
		slog.Error("create oauth state failed", "error", err)
		c.Redirect(http.StatusFound, s.appURL(returnTo, "login_error", loginErrFailed))
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Redirect(http.StatusFound, p.AuthCodeURL(state, verifier))
}

// Callback 处理 GET /auth/oauth/:provider/callback?code&state
func (s *Service) Callback(c *gin.Context) {
	ctx := c.Request.Context()
	c.Header("Cache-Control", "no-store")
	entry, err := s.states.Consume(ctx, c.Query("state"))
	if err != nil {
		c.Redirect(http.StatusFound, s.appURL("/", "login_error", loginErrInvalidState))
		return
	}
	// state 必须属于同一登录方式，防止拿 A 的 state 走 B 的回调
	if entry.Provider != c.Param("provider") {
		c.Redirect(http.StatusFound, s.appURL(entry.ReturnTo, "login_error", loginErrInvalidState))
		return
	}
	if e := c.Query("error"); e != "" {
		// 用户在授权页面点了取消（access_denied）或登录方式报错
		reason := loginErrFailed
		if e == "access_denied" {
			reason = loginErrCancelled
		}
		c.Redirect(http.StatusFound, s.appURL(entry.ReturnTo, "login_error", reason))
		return
	}
	p, err := s.Providers.Get(entry.Provider)
	if err != nil {
		c.Redirect(http.StatusFound, s.appURL(entry.ReturnTo, "login_error", loginErrUnknown))
		return
	}
	code := c.Query("code")
	if code == "" {
		c.Redirect(http.StatusFound, s.appURL(entry.ReturnTo, "login_error", loginErrFailed))
		return
	}

	exchangeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	identity, err := p.Exchange(exchangeCtx, code, entry.Verifier)
	if err != nil {
		slog.Warn("oauth exchange failed", "provider", p.Name(), "error", err)
		c.Redirect(http.StatusFound, s.appURL(entry.ReturnTo, "login_error", loginErrFailed))
		return
	}
	u, err := s.users.UpsertFromIdentity(ctx, identity)
	if err != nil {
		slog.Error("upsert user failed", "provider", p.Name(), "error", err)
		c.Redirect(http.StatusFound, s.appURL(entry.ReturnTo, "login_error", loginErrFailed))
		return
	}
	token, _, err := s.Sessions.Create(ctx, u.ID, p.Name(), c.Request.UserAgent())
	if err != nil {
		slog.Error("create session failed", "error", err)
		c.Redirect(http.StatusFound, s.appURL(entry.ReturnTo, "login_error", loginErrFailed))
		return
	}
	http.SetCookie(c.Writer, s.SessionCookie(token))
	slog.Info("user logged in", "user_id", u.ID, "provider", p.Name())
	c.Redirect(http.StatusFound, s.appURL(entry.ReturnTo, "login", "success"))
}

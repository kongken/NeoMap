package app

import (
	"context"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	neomapv1 "github.com/kongken/NeoMap/server/gen/neomap/v1"
	"github.com/kongken/NeoMap/server/gen/neomap/v1/neomapv1connect"
	"github.com/kongken/NeoMap/server/internal/auth/session"
)

type flow struct {
	t      *testing.T
	base   string
	env    *testAuthEnv
	client *http.Client
}

func newFlow(t *testing.T) *flow {
	srv := newTestServer(t, nil)
	return &flow{t: t, base: srv.URL, env: currentEnv, client: noRedirectClient()}
}

func (f *flow) get(path string, cookies ...*http.Cookie) *http.Response {
	f.t.Helper()
	req, _ := http.NewRequest(http.MethodGet, f.base+path, nil)
	for _, c := range cookies {
		req.AddCookie(c)
	}
	res, err := f.client.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	_ = res.Body.Close()
	return res
}

// start 发起登录并校验 PKCE 与回调地址，返回 state；code 非空时在假服务上登记该授权码。
func (f *flow) start(provider, returnTo, code string) (state string) {
	f.t.Helper()
	res := f.get("/auth/oauth/" + provider + "/start?return_to=" + returnTo)
	if res.StatusCode != http.StatusFound {
		f.t.Fatalf("start: status %d", res.StatusCode)
	}
	loc := mustURL(f.t, res.Header.Get("Location"))
	q := loc.Query()
	if q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" {
		f.t.Fatalf("start: 缺少 PKCE 参数：%s", loc)
	}
	if q.Get("redirect_uri") != testAPIBase+"/auth/oauth/"+provider+"/callback" {
		f.t.Fatalf("start: redirect_uri = %q", q.Get("redirect_uri"))
	}
	if code != "" {
		f.env.oauth.allowCode(code, q.Get("code_challenge"))
	}
	return q.Get("state")
}

// callback 访问回调地址，返回响应与跳转目标。
func (f *flow) callback(provider, query string) (*http.Response, string) {
	f.t.Helper()
	res := f.get("/auth/oauth/" + provider + "/callback?" + query)
	if res.StatusCode != http.StatusFound {
		f.t.Fatalf("callback: status %d", res.StatusCode)
	}
	return res, mustURL(f.t, res.Header.Get("Location")).String()
}

func sessionCookie(t *testing.T, res *http.Response) *http.Cookie {
	t.Helper()
	for _, c := range res.Cookies() {
		if c.Name == "neomap_session" {
			return c
		}
	}
	t.Fatal("响应中没有会话 Cookie")
	return nil
}

func (f *flow) authClient(cookie *http.Cookie) neomapv1connect.AuthServiceClient {
	jar, _ := cookiejar.New(nil)
	u := mustURL(f.t, f.base)
	if cookie != nil {
		jar.SetCookies(u, []*http.Cookie{{Name: cookie.Name, Value: cookie.Value}})
	}
	return neomapv1connect.NewAuthServiceClient(&http.Client{Jar: jar}, f.base)
}

func (f *flow) me(cookie *http.Cookie) *neomapv1.User {
	f.t.Helper()
	res, err := f.authClient(cookie).GetMe(context.Background(), connect.NewRequest(&neomapv1.GetMeRequest{}))
	if err != nil {
		f.t.Fatal(err)
	}
	return res.Msg.GetUser()
}

func TestListProvidersAndAnonymous(t *testing.T) {
	f := newFlow(t)
	res, err := f.authClient(nil).ListProviders(context.Background(), connect.NewRequest(&neomapv1.ListProvidersRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, p := range res.Msg.GetProviders() {
		names = append(names, p.GetName()+":"+p.GetDisplayName())
	}
	if strings.Join(names, ",") != "github:GitHub,google:Google" {
		t.Fatalf("providers = %v", names)
	}
	if u := f.me(nil); u != nil {
		t.Fatalf("未登录时 GetMe 应返回空 user，得到 %+v", u)
	}
	// 无效 Cookie：视为未登录并清除 Cookie
	r := f.get("/healthz", &http.Cookie{Name: "neomap_session", Value: "bogus"})
	if c := sessionCookie(t, r); c.MaxAge >= 0 {
		t.Fatalf("无效会话应被清除，MaxAge = %d", c.MaxAge)
	}
}

func TestGitHubLoginFlow(t *testing.T) {
	f := newFlow(t)
	state := f.start("github", "/trips%3Fx%3D1", "code-1")
	res, loc := f.callback("github", "code=code-1&state="+state)
	if loc != testAppBase+"/trips?login=success&x=1" {
		t.Fatalf("登录后跳转到 %q", loc)
	}
	c := sessionCookie(t, res)
	if !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteLaxMode || c.MaxAge != int((720*time.Hour)/time.Second) {
		t.Fatalf("Cookie 属性不正确：%+v", c)
	}
	u := f.me(c)
	if u == nil || u.GetDisplayName() != "Octo Cat" || u.GetProvider() != "github" || u.GetAvatarUrl() == "" {
		t.Fatalf("GetMe = %+v", u)
	}
	// 只采用已验证的主邮箱
	if u.GetEmail() != "octo@example.com" {
		t.Fatalf("email = %q", u.GetEmail())
	}

	// state 只能使用一次
	_, loc = f.callback("github", "code=code-1&state="+state)
	if !strings.Contains(loc, "login_error=invalid_state") {
		t.Fatalf("重放 state：%s", loc)
	}

	// 再次登录同一 GitHub 账号：同一用户，资料被更新
	f.env.oauth.githubUser["name"] = "Octo Renamed"
	state = f.start("github", "/", "code-2")
	res, _ = f.callback("github", "code=code-2&state="+state)
	u2 := f.me(sessionCookie(t, res))
	if u2.GetId() != u.GetId() || u2.GetDisplayName() != "Octo Renamed" {
		t.Fatalf("再次登录：%+v（原用户 %s）", u2, u.GetId())
	}
}

func TestGoogleLoginAndUnverifiedEmail(t *testing.T) {
	f := newFlow(t)
	f.env.oauth.googleUser["email_verified"] = false
	state := f.start("google", "/", "g-code")
	res, loc := f.callback("google", "code=g-code&state="+state)
	if !strings.HasSuffix(loc, "/?login=success") {
		t.Fatalf("跳转 %s", loc)
	}
	u := f.me(sessionCookie(t, res))
	if u.GetProvider() != "google" || u.GetDisplayName() != "Gina" {
		t.Fatalf("GetMe = %+v", u)
	}
	if u.GetEmail() != "" {
		t.Fatalf("未验证邮箱不应保存，得到 %q", u.GetEmail())
	}
}

func TestLoginFailures(t *testing.T) {
	f := newFlow(t)

	// 用户在授权页取消
	state := f.start("github", "/a", "")
	_, loc := f.callback("github", "error=access_denied&state="+state)
	if loc != testAppBase+"/a?login_error=cancelled" {
		t.Fatalf("取消：%s", loc)
	}

	// PKCE 不匹配 / 授权码无效 → 换取令牌失败
	state = f.start("github", "/", "")
	_, loc = f.callback("github", "code=never-issued&state="+state)
	if !strings.Contains(loc, "login_error=failed") {
		t.Fatalf("授权码无效：%s", loc)
	}

	// 用 GitHub 的 state 走 Google 回调
	state = f.start("github", "/", "x")
	_, loc = f.callback("google", "code=x&state="+state)
	if !strings.Contains(loc, "login_error=invalid_state") {
		t.Fatalf("state 与登录方式不符：%s", loc)
	}

	// 未知 state
	_, loc = f.callback("github", "code=x&state=unknown")
	if !strings.Contains(loc, "login_error=invalid_state") {
		t.Fatalf("未知 state：%s", loc)
	}

	// 未配置的登录方式
	res := f.get("/auth/oauth/twitter/start")
	if !strings.Contains(res.Header.Get("Location"), "login_error=unknown_provider") {
		t.Fatalf("未知登录方式：%s", res.Header.Get("Location"))
	}

	// 外部 return_to 被替换为站内根路径（防开放重定向）
	state = f.start("github", "https:%2F%2Fevil.example%2Fsteal", "ok")
	_, loc = f.callback("github", "code=ok&state="+state)
	if loc != testAppBase+"/?login=success" {
		t.Fatalf("开放重定向防护：%s", loc)
	}
}

func TestLoginRateLimit(t *testing.T) {
	f := newFlow(t)
	for i := 0; i < 5; i++ {
		f.start("github", "/", "")
	}
	res := f.get("/auth/oauth/github/start")
	if !strings.Contains(res.Header.Get("Location"), "login_error=rate_limited") {
		t.Fatalf("超过限流：%s", res.Header.Get("Location"))
	}
	// 窗口过后恢复
	f.env.mr.FastForward(61 * time.Second)
	f.start("github", "/", "")
}

func (f *flow) login(code string) *http.Cookie {
	f.t.Helper()
	state := f.start("github", "/", code)
	res, _ := f.callback("github", "code="+code+"&state="+state)
	return sessionCookie(f.t, res)
}

func TestLogout(t *testing.T) {
	f := newFlow(t)
	a := f.login("c-a")
	b := f.login("c-b") // 同一用户的第二个设备

	res, err := f.authClient(a).Logout(context.Background(), connect.NewRequest(&neomapv1.LogoutRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.Header().Get("Set-Cookie"), "Max-Age=0") {
		t.Fatalf("退出时应清除 Cookie：%q", res.Header().Get("Set-Cookie"))
	}
	if f.me(a) != nil {
		t.Fatal("退出后旧 Cookie 仍有效")
	}
	if f.me(b) == nil {
		t.Fatal("只退出当前设备时，其他设备不应受影响")
	}

	c := f.login("c-c")
	if _, err := f.authClient(c).Logout(context.Background(), connect.NewRequest(&neomapv1.LogoutRequest{AllDevices: true})); err != nil {
		t.Fatal(err)
	}
	if f.me(b) != nil || f.me(c) != nil {
		t.Fatal("退出所有设备后仍有会话有效")
	}
}

func TestSessionRenewalAndDeletedUser(t *testing.T) {
	f := newFlow(t)
	c := f.login("r-1")
	u := f.me(c)

	// 未到续期点：不刷新 Cookie
	if res := f.get("/healthz", c); len(res.Cookies()) != 0 {
		t.Fatal("未到续期点不应写 Cookie")
	}
	// 过了一半有效期：续期并刷新 Cookie
	f.env.mr.FastForward(361 * time.Hour)
	res := f.get("/healthz", c)
	if rc := sessionCookie(t, res); rc.Value != c.Value || rc.MaxAge != int((720*time.Hour)/time.Second) {
		t.Fatalf("续期 Cookie：%+v", rc)
	}
	if ttl := f.env.mr.TTL("neomap:session:" + session.HashToken(c.Value)); ttl < 719*time.Hour {
		t.Fatalf("续期后 TTL = %v", ttl)
	}
	// 超过有效期：失效
	f.env.mr.FastForward(721 * time.Hour)
	if f.me(c) != nil {
		t.Fatal("过期会话仍有效")
	}

	// 会话指向已删除用户：视为未登录
	c = f.login("r-2")
	f.env.users.Delete(u.GetId())
	if f.me(c) != nil {
		t.Fatal("用户删除后仍返回 user")
	}
}

func TestOriginCheck(t *testing.T) {
	f := newFlow(t)
	post := func(origin string) int {
		req, _ := http.NewRequest(http.MethodPost, f.base+"/neomap.v1.AuthService/Logout", strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		return res.StatusCode
	}
	if code := post("https://evil.example"); code != http.StatusForbidden {
		t.Fatalf("外部来源的写请求：%d", code)
	}
	if code := post(allowedOrigin); code != http.StatusOK {
		t.Fatalf("白名单来源：%d", code)
	}
	if code := post(""); code != http.StatusOK {
		t.Fatalf("无 Origin（非浏览器）：%d", code)
	}
}

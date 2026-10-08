package provider

import (
	"context"
	"fmt"
	"net/http"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/endpoints"
)

const googleUserInfoURL = "https://openidconnect.googleapis.com/v1/userinfo"

type GoogleConfig struct {
	ClientID     string
	ClientSecret string
	RedirectURL  string
	// 端点覆盖，仅测试使用。
	AuthURL     string
	TokenURL    string
	UserInfoURL string
	HTTPClient  *http.Client
}

type Google struct {
	oauth       *oauth2.Config
	userInfoURL string
	client      *http.Client
}

func NewGoogle(c GoogleConfig) *Google {
	ep := endpoints.Google
	if c.AuthURL != "" {
		ep.AuthURL = c.AuthURL
	}
	if c.TokenURL != "" {
		ep.TokenURL = c.TokenURL
	}
	g := &Google{
		oauth: &oauth2.Config{
			ClientID:     c.ClientID,
			ClientSecret: c.ClientSecret,
			RedirectURL:  c.RedirectURL,
			Endpoint:     ep,
			Scopes:       []string{"openid", "email", "profile"},
		},
		userInfoURL: orDefault(c.UserInfoURL, googleUserInfoURL),
		client:      c.HTTPClient,
	}
	if g.client == nil {
		g.client = http.DefaultClient
	}
	return g
}

func (g *Google) Name() string        { return "google" }
func (g *Google) DisplayName() string { return "Google" }

func (g *Google) AuthCodeURL(state, verifier string) string {
	// prompt=select_account：允许用户在多个 Google 账号间选择
	return g.oauth.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier), oauth2.SetAuthURLParam("prompt", "select_account"))
}

func (g *Google) Exchange(ctx context.Context, code, verifier string) (*Identity, error) {
	ctx = context.WithValue(ctx, oauth2.HTTPClient, g.client)
	tok, err := g.oauth.Exchange(ctx, code, oauth2.VerifierOption(verifier))
	if err != nil {
		return nil, fmt.Errorf("google: 换取令牌失败: %w", err)
	}
	var u struct {
		Sub           string `json:"sub"`
		Name          string `json:"name"`
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
		Picture       string `json:"picture"`
	}
	if err := getJSON(ctx, g.oauth.Client(ctx, tok), g.userInfoURL, "application/json", &u); err != nil {
		return nil, fmt.Errorf("google: 读取用户信息失败: %w", err)
	}
	if u.Sub == "" {
		return nil, fmt.Errorf("google: 用户信息缺少 sub")
	}
	email := ""
	if u.EmailVerified {
		email = u.Email
	}
	return &Identity{
		Provider:    g.Name(),
		Subject:     u.Sub,
		DisplayName: displayNameOf(u.Name, email),
		Email:       email,
		AvatarURL:   u.Picture,
	}, nil
}

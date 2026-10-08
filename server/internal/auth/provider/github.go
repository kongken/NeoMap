package provider

import (
	"context"
	"fmt"
	"net/http"
	"strconv"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/endpoints"
)

const (
	githubUserURL   = "https://api.github.com/user"
	githubEmailsURL = "https://api.github.com/user/emails"
	githubAccept    = "application/vnd.github+json"
)

type GitHubConfig struct {
	ClientID     string
	ClientSecret string
	RedirectURL  string
	// 端点覆盖：测试或 GitHub Enterprise 使用；留空为 github.com。
	AuthURL    string
	TokenURL   string
	UserURL    string
	EmailsURL  string
	HTTPClient *http.Client
}

type GitHub struct {
	oauth     *oauth2.Config
	userURL   string
	emailsURL string
	client    *http.Client
}

func NewGitHub(c GitHubConfig) *GitHub {
	ep := endpoints.GitHub
	if c.AuthURL != "" {
		ep.AuthURL = c.AuthURL
	}
	if c.TokenURL != "" {
		ep.TokenURL = c.TokenURL
	}
	g := &GitHub{
		oauth: &oauth2.Config{
			ClientID:     c.ClientID,
			ClientSecret: c.ClientSecret,
			RedirectURL:  c.RedirectURL,
			Endpoint:     ep,
			Scopes:       []string{"read:user", "user:email"},
		},
		userURL:   orDefault(c.UserURL, githubUserURL),
		emailsURL: orDefault(c.EmailsURL, githubEmailsURL),
		client:    c.HTTPClient,
	}
	if g.client == nil {
		g.client = http.DefaultClient
	}
	return g
}

func (g *GitHub) Name() string        { return "github" }
func (g *GitHub) DisplayName() string { return "GitHub" }

func (g *GitHub) AuthCodeURL(state, verifier string) string {
	return g.oauth.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier), oauth2.SetAuthURLParam("allow_signup", "true"))
}

func (g *GitHub) Exchange(ctx context.Context, code, verifier string) (*Identity, error) {
	ctx = context.WithValue(ctx, oauth2.HTTPClient, g.client)
	tok, err := g.oauth.Exchange(ctx, code, oauth2.VerifierOption(verifier))
	if err != nil {
		return nil, fmt.Errorf("github: 换取令牌失败: %w", err)
	}
	client := g.oauth.Client(ctx, tok)

	var u struct {
		ID        int64  `json:"id"`
		Login     string `json:"login"`
		Name      string `json:"name"`
		AvatarURL string `json:"avatar_url"`
	}
	if err := getJSON(ctx, client, g.userURL, githubAccept, &u); err != nil {
		return nil, fmt.Errorf("github: 读取用户信息失败: %w", err)
	}
	if u.ID == 0 {
		return nil, fmt.Errorf("github: 用户信息缺少 id")
	}

	// 只采用 /user/emails 中已验证的邮箱：/user 返回的公开邮箱不保证已验证
	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	email := ""
	if err := getJSON(ctx, client, g.emailsURL, githubAccept, &emails); err == nil {
		for _, e := range emails {
			if e.Verified && (email == "" || e.Primary) {
				email = e.Email
			}
		}
	}

	return &Identity{
		Provider:    g.Name(),
		Subject:     strconv.FormatInt(u.ID, 10),
		DisplayName: displayNameOf(u.Name, u.Login),
		Email:       email,
		AvatarURL:   u.AvatarURL,
	}, nil
}

func orDefault(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

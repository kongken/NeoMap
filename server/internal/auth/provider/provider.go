// Package provider 实现 GitHub、Google 的 OAuth 2.0 授权码登录（带 PKCE）。
package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"golang.org/x/oauth2"
)

// Identity 是登录方式返回的用户身份。
type Identity struct {
	Provider string
	// Subject 是登录方式内稳定的用户 ID（GitHub 数字 ID、Google sub）。
	Subject     string
	DisplayName string
	// Email 只在登录方式确认已验证时填写。
	Email     string
	AvatarURL string
}

type Provider interface {
	Name() string
	DisplayName() string
	// AuthCodeURL 返回跳转到登录方式的授权地址。verifier 为 PKCE code_verifier。
	AuthCodeURL(state, verifier string) string
	// Exchange 用授权码换取令牌并读取用户身份。
	Exchange(ctx context.Context, code, verifier string) (*Identity, error)
}

var ErrUnknownProvider = errors.New("未配置该登录方式")

// Registry 保存已启用的登录方式，保持注册顺序。
type Registry struct {
	order []string
	byKey map[string]Provider
}

func NewRegistry(providers ...Provider) *Registry {
	r := &Registry{byKey: map[string]Provider{}}
	for _, p := range providers {
		if p == nil {
			continue
		}
		r.order = append(r.order, p.Name())
		r.byKey[p.Name()] = p
	}
	return r
}

func (r *Registry) Get(name string) (Provider, error) {
	if p, ok := r.byKey[name]; ok {
		return p, nil
	}
	return nil, ErrUnknownProvider
}

func (r *Registry) List() []Provider {
	out := make([]Provider, 0, len(r.order))
	for _, name := range r.order {
		out = append(out, r.byKey[name])
	}
	return out
}

// GenerateVerifier 生成 PKCE code_verifier。
func GenerateVerifier() string { return oauth2.GenerateVerifier() }

// getJSON 用访问令牌请求 JSON 接口。
func getJSON(ctx context.Context, client *http.Client, url, accept string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", accept)
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("GET %s: HTTP %d: %s", url, res.StatusCode, strings.TrimSpace(string(body)))
	}
	return json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(out)
}

// displayNameOf 取第一个非空候选作为显示名；若是邮箱则只取 @ 前部分，避免把邮箱当昵称展示。
func displayNameOf(candidates ...string) string {
	for _, c := range candidates {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		if at := strings.IndexByte(c, '@'); at > 0 {
			return c[:at]
		}
		return c
	}
	return "NeoMap 用户"
}

package storage

import (
	"net/url"
	"testing"

	"butterfly.orx.me/core/mod"
)

func TestPostgresDSNEscapesCredentials(t *testing.T) {
	dsn := PostgresDSN(mod.DBConfig{
		Host: "db.internal", Port: 5432, User: "neo map", Password: "p@ss:w/rd?#", DBName: "neomap", SSLMode: "require",
	})
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("DSN 无法解析：%v", err)
	}
	pw, _ := u.User.Password()
	if u.User.Username() != "neo map" || pw != "p@ss:w/rd?#" {
		t.Fatalf("凭据未正确往返：%q / %q", u.User.Username(), pw)
	}
	if u.Host != "db.internal:5432" || u.Path != "/neomap" || u.Query().Get("sslmode") != "require" {
		t.Fatalf("unexpected DSN: %s", dsn)
	}
}

func TestPostgresDSNDefaultsSSLMode(t *testing.T) {
	u, _ := url.Parse(PostgresDSN(mod.DBConfig{Host: "h", Port: 1, User: "u", Password: "p", DBName: "d"}))
	if u.Query().Get("sslmode") != "disable" {
		t.Fatalf("sslmode = %q", u.Query().Get("sslmode"))
	}
}

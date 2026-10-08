package auth

import "testing"

func TestSafeReturnTo(t *testing.T) {
	cases := map[string]string{
		"":                       "/",
		"/":                      "/",
		"/trips?x=1#map":         "/trips?x=1#map",
		"//evil.example/path":    "/",
		"/\\evil.example":        "/",
		"https://evil.example/":  "/",
		"javascript:alert(1)":    "/",
		"relative/path":          "/",
		"/ok\r\nSet-Cookie: a=b": "/",
	}
	for in, want := range cases {
		if got := SafeReturnTo(in); got != want {
			t.Errorf("SafeReturnTo(%q) = %q, want %q", in, got, want)
		}
	}
	long := "/" + string(make([]byte, 600))
	if SafeReturnTo(long) != "/" {
		t.Error("超长 return_to 应被拒绝")
	}
}

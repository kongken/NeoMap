// Package migrations 以 embed 方式把 SQL 迁移文件打包进二进制。
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS

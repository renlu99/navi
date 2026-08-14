#!/bin/sh
set -eu

cd "$(dirname "$0")"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${APP_PASSWORD:?APP_PASSWORD is required}"

# Go 运行环境首次启动时自动生成 go.sum 并下载依赖。
go mod tidy
go build -trimpath -ldflags="-s -w" -o site-navigation main.go
exec ./site-navigation

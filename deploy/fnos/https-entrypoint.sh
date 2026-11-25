#!/bin/sh
set -eu

# 自定义 443 配置只需模板替换，避免默认 IPv6 脚本的 apk manifest 查询阻塞启动。
/docker-entrypoint.d/20-envsubst-on-templates.sh
exec nginx -g 'daemon off;'

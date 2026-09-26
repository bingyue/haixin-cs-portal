#!/bin/sh
set -eu

portal_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
portal_node=$(command -v node)
portal_label='com.haixin.cs-portal'
portal_plist="$HOME/Library/LaunchAgents/$portal_label.plist"
portal_logs="$HOME/Library/Logs"
portal_domain="gui/$(id -u)"

if [ ! -f "$portal_root/.env" ]; then
  printf '缺少 %s/.env，请先配置扣子访问令牌。\n' "$portal_root" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$portal_logs"
python3 - "$portal_root" "$portal_node" "$portal_plist" "$portal_logs" "$portal_label" <<'PY'
import plistlib
import sys

portal_root, portal_node, portal_plist, portal_logs, portal_label = sys.argv[1:]
service = {
    'Label': portal_label,
    'ProgramArguments': [portal_node, '--env-file-if-exists=.env', 'server.js'],
    'WorkingDirectory': portal_root,
    'EnvironmentVariables': {'NODE_ENV': 'production'},
    'RunAtLoad': True,
    'KeepAlive': True,
    'ThrottleInterval': 10,
    'ProcessType': 'Background',
    'Umask': 0o077,
    'StandardOutPath': f'{portal_logs}/haixin-cs-portal.out.log',
    'StandardErrorPath': f'{portal_logs}/haixin-cs-portal.err.log',
}
with open(portal_plist, 'wb') as handle:
    plistlib.dump(service, handle)
PY

plutil -lint "$portal_plist"
launchctl bootout "$portal_domain/$portal_label" >/dev/null 2>&1 || true
launchctl bootstrap "$portal_domain" "$portal_plist"
printf '已安装并启动 %s\n' "$portal_label"

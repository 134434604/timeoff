#!/usr/bin/env bash
# Runs ON a fresh Debian 12 VM as root. Installs Node 24, Caddy (automatic
# https), and Time Off as a systemd service under /opt/timeoff. The release
# tarball is uploaded separately (scripts/gcp/release.sh); this script only
# prepares the box and (re)starts the service when a release is present.
#
#   sudo DOMAIN=timeoff.example.com bash install.sh
set -euo pipefail
DOMAIN="${DOMAIN:?Set DOMAIN=timeoff.example.com}"
APP=/opt/timeoff

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https

# Node 24 from NodeSource
if ! command -v node >/dev/null || [[ "$(node -v)" != v24* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -q nodejs
fi

# Caddy: terminates https with a Let's Encrypt certificate it renews itself
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi
cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
    reverse_proxy 127.0.0.1:5610
    encode gzip
}
CADDY
systemctl enable --now caddy
systemctl reload caddy

# The app user and folders; data/ is the whole state
id -u timeoff >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin timeoff
mkdir -p "$APP/data" "$APP/releases"
chown -R timeoff:timeoff "$APP"
chmod 700 "$APP/data"

# Environment: everything secret is entered on the app's /setup page, so
# this file holds only the public origin and operational settings.
if [[ ! -f "$APP/.env.local" ]]; then
  cat > "$APP/.env.local" <<ENV
NODE_ENV=production
PUBLIC_ORIGIN=https://${DOMAIN}
PORT=5610
HOST=127.0.0.1
TRUST_PROXY=1
DATA_DIR=${APP}/data
ENV
  chown timeoff:timeoff "$APP/.env.local"; chmod 600 "$APP/.env.local"
fi

cat > /etc/systemd/system/timeoff.service <<UNIT
[Unit]
Description=Time Off
After=network-online.target
Wants=network-online.target

[Service]
User=timeoff
WorkingDirectory=${APP}/current
ExecStart=/usr/bin/node --env-file-if-exists=${APP}/.env.local server/index.mjs
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable timeoff

# Nightly backup of data/ kept for 30 days (copy them off the box too)
cat > /etc/cron.daily/timeoff-backup <<'CRON'
#!/usr/bin/env bash
set -e
d=/opt/timeoff/backups; mkdir -p "$d"
tar -czf "$d/data-$(date +%F).tar.gz" -C /opt/timeoff data
find "$d" -name 'data-*.tar.gz' -mtime +30 -delete
CRON
chmod +x /etc/cron.daily/timeoff-backup

if [[ -d "$APP/current" ]]; then systemctl restart timeoff; fi
echo "Ready. Upload a release with scripts/gcp/release.sh, then: curl -s https://${DOMAIN}/healthz"

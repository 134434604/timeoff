#!/usr/bin/env bash
# Ships a release to the VM and restarts the app. Runs from Cloud Shell or
# any terminal with gcloud signed in to the project. Needs nothing locally
# but gcloud and tar: the client is built ON the VM (it has Node 24), so
# this works from a machine with no Node at all.
#
#   VM=timeoff ZONE=us-east1-b PROJECT=$(gcloud config get-value project) bash scripts/gcp/release.sh
#
# Never ships data/ or .env files; each release lands in its own folder and
# /opt/timeoff/current is switched only after the build succeeded.
set -euo pipefail
VM="${VM:?}"; ZONE="${ZONE:?}"; PROJECT="${PROJECT:?}"
cd "$(dirname "$0")/../.."
stamp=$(date +%Y%m%d-%H%M%S)
tmp=$(mktemp -d)
tar -czf "$tmp/release.tgz" \
  --exclude='server/reference' --exclude='node_modules' --exclude='dist' --exclude='data' --exclude='.env*' \
  server scripts src docs index.html vite.config.ts tsconfig.json package.json package-lock.json
gcloud compute scp "$tmp/release.tgz" "$VM:/tmp/release-$stamp.tgz" --zone "$ZONE" --project "$PROJECT"
rm -rf "$tmp"
gcloud compute ssh "$VM" --zone "$ZONE" --project "$PROJECT" --command "sudo bash -c '
  set -e
  dir=/opt/timeoff/releases/$stamp
  mkdir -p \$dir && tar -xzf /tmp/release-$stamp.tgz -C \$dir && rm /tmp/release-$stamp.tgz
  cd \$dir
  npm ci --no-audit --no-fund --loglevel=error
  npm run build:client >/dev/null
  rm -rf node_modules
  chown -R timeoff:timeoff \$dir
  ln -sfn \$dir /opt/timeoff/current
  systemctl restart timeoff
  sleep 3
  curl -fsS http://127.0.0.1:5610/healthz && echo
  ls -dt /opt/timeoff/releases/* | tail -n +6 | xargs -r rm -rf
'"
echo "Released $stamp"

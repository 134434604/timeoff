#!/usr/bin/env bash
# Creates the VM in her Google Cloud project. Run in Cloud Shell (console →
# the terminal icon, top right) or anywhere gcloud is signed in to that
# project. One small VM is plenty: e2-micro is in the free tier in us-east1,
# us-west1 and us-central1.
#
#   PROJECT=her-project-id DOMAIN=timeoff.example.com bash create-vm.sh
set -euo pipefail
PROJECT="${PROJECT:?}"; DOMAIN="${DOMAIN:?}"
ZONE="${ZONE:-us-east1-b}"; VM="${VM:-timeoff}"
gcloud config set project "$PROJECT" >/dev/null
gcloud services enable compute.googleapis.com >/dev/null
gcloud compute addresses create "$VM-ip" --region "${ZONE%-*}" 2>/dev/null || true
IP=$(gcloud compute addresses describe "$VM-ip" --region "${ZONE%-*}" --format='value(address)')
gcloud compute instances create "$VM" --zone "$ZONE" --machine-type e2-micro \
  --image-family debian-12 --image-project debian-cloud --boot-disk-size 20GB \
  --address "$IP" --tags http-server,https-server >/dev/null
gcloud compute firewall-rules create allow-timeoff-web --allow tcp:80,tcp:443 --target-tags http-server,https-server 2>/dev/null || true
echo "VM $VM is up at $IP."
echo "1. At your domain's DNS, add an A record: $DOMAIN -> $IP"
echo "2. Copy the installer: gcloud compute scp scripts/gcp/install.sh $VM:/tmp/install.sh --zone $ZONE"
echo "3. Then: gcloud compute ssh $VM --zone $ZONE -- sudo DOMAIN=$DOMAIN bash /tmp/install.sh"

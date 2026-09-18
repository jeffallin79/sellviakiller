#!/usr/bin/env bash
# Happy-path smoke against local API (no browser).
set -euo pipefail
API="${API_URL:-http://localhost:4000}/api"
EMAIL="demo$(date +%s)@storeforge.local"
PASS="password123"

echo "== bootstrap =="
curl -sS -X POST "$API/auth/bootstrap" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"name\":\"Demo\",\"accountName\":\"Demo Co\"}" | tee /tmp/sf-boot.json

echo "== health =="
curl -sS "$API/health" | tee /tmp/sf-health.json
echo
echo "Use admin UI to sign in as $EMAIL / $PASS"

#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# StoreForge Phase 0 — API smoke script (NOT full E2E)
#
# What this covers:
#   - POST /api/auth/bootstrap (create merchant)
#   - GET  /api/health
#
# What this does NOT cover (use admin UI + storefront, or expand later):
#   - Browser auth cookies / Better Auth sign-in
#   - Store provision, catalog import, checkout, fulfillment, CSV export
#   - Soft-delete / slug reuse / stub-pay gating
#
# Usage:
#   API_URL=http://127.0.0.1:4000 ./scripts/demo-flow.sh
# -----------------------------------------------------------------------------
set -euo pipefail
API="${API_URL:-http://localhost:4000}/api"
EMAIL="demo$(date +%s)@storeforge.local"
PASS="password123"

echo "== StoreForge smoke (bootstrap + health only) =="
echo "== bootstrap =="
curl -sS -X POST "$API/auth/bootstrap" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"name\":\"Demo\",\"accountName\":\"Demo Co\"}" | tee /tmp/sf-boot.json
echo
echo "== health =="
curl -sS "$API/health" | tee /tmp/sf-health.json
echo
echo "Smoke OK. Sign in via admin UI as $EMAIL / $PASS"
echo "(This script is intentionally smoke-only — not a full E2E suite.)"

#!/usr/bin/env bash
# The Viber Activity Checker with nothing but cURL, one step at a time.
# Run each step on its own and read the answer before the next one.
#
#   export TALISMANLEADS_API_KEY="tl_live_..."
#
# Docs: https://docs.talismanleads.io/checkers/viber_activity_checker
set -euo pipefail

API="https://api.talismanleads.io/v1"
AUTH="Authorization: Bearer ${TALISMANLEADS_API_KEY:?Set TALISMANLEADS_API_KEY first}"

step="${1:-}"
case "$step" in
  estimate)
    # 1. See what it would cost. Charges nothing.
    curl -sS -X POST "$API/estimates" -H "$AUTH" -H "Content-Type: application/json" \
      -d '{"checker":"viber_activity_checker","entries":["+14155550142", "+12125550187"]}'
    ;;
  order)
    # 2. Place the order. Keep the Idempotency-Key with your own record: sending
    #    the same key again within 7 days returns the same order, charged once.
    KEY="${2:?Usage: curl.sh order <idempotency-key>, for example a UUID}"
    curl -sS -X POST "$API/orders" -H "$AUTH" -H "Content-Type: application/json" \
      -H "Idempotency-Key: $KEY" \
      -d '{"checker":"viber_activity_checker","entries":["+14155550142", "+12125550187"]}'
    ;;
  status)
    # 3. Follow the order. Ask every 30 seconds or more.
    curl -sS "$API/orders/${2:?Usage: curl.sh status <order-id>}" -H "$AUTH"
    ;;
  results)
    # 4. Get a download link for each part of the result, good for 15 minutes.
    curl -sS "$API/orders/${2:?Usage: curl.sh results <order-id>}/results" -H "$AUTH"
    ;;
  *)
    echo "Usage: $0 estimate | order <idempotency-key> | status <order-id> | results <order-id>" >&2
    exit 2
    ;;
esac
echo

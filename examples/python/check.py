#!/usr/bin/env python3
"""
Run a TalismanLeads checker over a list, from start to finish:
see the price, place the order, wait for it, and download the result.

    export TALISMANLEADS_API_KEY="tl_live_..."
    python3 check.py list.txt

The list is a .txt file with one entry on each line. Phone numbers are
written with their country code, such as +14155550142.

Only the Python standard library is used (Python 3.8 or newer).
Docs: https://docs.talismanleads.io
"""

import argparse
import http.client
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

DEFAULT_CHECKER = "viber_activity_checker"
API_BASE = os.environ.get("TALISMANLEADS_API_BASE", "https://api.talismanleads.io/v1").rstrip("/")

# A list this large goes up as a file (POST /uploads) instead of in the request.
INLINE_MAX_ENTRIES = 100_000
INLINE_MAX_BYTES = 3_900_000  # the request's limit is 4 MB; keep a margin

# Refusals that mean "wait and send the same request again". On an order the
# same Idempotency-Key makes the repeat safe: it is never charged twice.
RETRYABLE = {"rate_limited", "too_many_open_orders", "order_status_unknown", "service_unavailable",
             "internal_error", "api_disabled"}

# Statuses after which an order no longer changes. Any other status, including
# one added later, is treated as still running.
FINISHED = {"completed", "partially_completed", "failed"}
POLL_SECONDS = 30


class ApiError(Exception):
    def __init__(self, status, code, message, request_id=None, retry_after=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.request_id = request_id
        self.retry_after = retry_after

    def __str__(self):
        ref = f" (request_id {self.request_id})" if self.request_id else ""
        return f"{self.code}: {self.args[0]}{ref}"


def api(method, path, key, body=None, headers=None, timeout=330):
    """Calls the API and returns the parsed JSON, or raises ApiError."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API_BASE + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    for name, value in (headers or {}).items():
        req.add_header(name, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            e = json.loads(raw)["error"]
            raise ApiError(err.code, e.get("code", "unknown"), e.get("message", ""), e.get("request_id"),
                           err.headers.get("Retry-After")) from None
        except (ValueError, KeyError, TypeError):
            # Not our JSON: a gateway's 502 or 504. For an order this means
            # "unknown", and the same Idempotency-Key settles it.
            raise ApiError(err.code, "order_status_unknown" if err.code >= 500 else "http_error",
                           f"HTTP {err.code} without a JSON answer") from None


def call_with_retries(method, path, key, body=None, headers=None, attempts=6):
    """Retries what is safe to retry: rate limits, lost answers and gateway errors."""
    for attempt in range(1, attempts + 1):
        try:
            return api(method, path, key, body, headers)
        except ApiError as err:
            if err.code not in RETRYABLE or attempt == attempts:
                raise
            wait = int(err.retry_after) if (err.retry_after or "").isdigit() else 60
            print(f"  {err.code}; trying again in {wait} s", file=sys.stderr)
            time.sleep(wait)
        except (OSError, http.client.HTTPException) as err:
            # A dropped connection or a timeout: the answer was lost, not refused.
            if attempt == attempts:
                raise
            print(f"  connection problem ({err}); trying again in 60 s", file=sys.stderr)
            time.sleep(60)


def read_entries(path):
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    return [line.strip() for line in lines if line.strip()]


def upload(path, key):
    """Sends a large list straight to storage and returns its upload_id."""
    size = os.path.getsize(path)
    link = call_with_retries("POST", "/uploads", key, {"file_name": Path(path).with_suffix(".txt").name, "size_bytes": size})
    req = urllib.request.Request(link["upload_url"], data=Path(path).read_bytes(), method=link.get("method", "PUT"))
    for name, value in (link.get("headers") or {}).items():
        req.add_header(name, value)
    # The link carries its own permission: the API key is never sent to it.
    with urllib.request.urlopen(req, timeout=600):
        pass
    return link["upload_id"]


def download(url, target):
    # Download links carry their own permission, so no API key here either.
    with urllib.request.urlopen(url, timeout=600) as res, open(target, "wb") as out:
        while chunk := res.read(1 << 20):
            out.write(chunk)


def main():
    parser = argparse.ArgumentParser(description="Run a TalismanLeads checker over a list.")
    parser.add_argument("list", help="a .txt file with one entry per line")
    parser.add_argument("--checker", default=DEFAULT_CHECKER, help=f"checker id (default {DEFAULT_CHECKER})")
    parser.add_argument("--country", help="two-letter country of the numbers, such as US")
    parser.add_argument("--yes", action="store_true", help="place the order without asking")
    parser.add_argument("--new", action="store_true", help="start a new order even if this list has one in progress")
    parser.add_argument("--out", default="results", help="folder for the result files (default results)")
    args = parser.parse_args()

    key = os.environ.get("TALISMANLEADS_API_KEY")
    if not key:
        sys.exit("Set TALISMANLEADS_API_KEY first. Create a key at https://talismanleads.io/api-keys")

    # The state file keeps the Idempotency-Key and the order id beside the list,
    # so running the script again picks the same order up instead of paying twice.
    state_path = Path(str(args.list) + ".order.json")
    state = {} if args.new or not state_path.exists() else json.loads(state_path.read_text())
    if state.get("checker") not in (None, args.checker):
        sys.exit(f"{state_path} belongs to an order for {state['checker']}. Use --new to start another.")

    try:
        if not state.get("order_id") and not state.get("order_body"):
            body = {"checker": args.checker, "file_name": Path(args.list).with_suffix(".txt").name}
            if args.country:
                body["country"] = args.country.upper()
            entries = read_entries(args.list)
            # The 4 MB limit is on the request, which is larger than the file.
            if len(entries) > INLINE_MAX_ENTRIES or len(json.dumps({**body, "entries": entries})) > INLINE_MAX_BYTES:
                print(f"Uploading {len(entries):,} entries…")
                body["upload_id"] = upload(args.list, key)
            else:
                body["entries"] = entries

            quote = call_with_retries("POST", "/estimates", key, body)
            print(f"{quote['entries']:,} entries, billed as {quote['billed_entries']:,}: "
                  f"{quote['charge']} {quote['currency']}")
            if not args.yes and input("Place the order? [y/N] ").strip().lower() not in ("y", "yes"):
                print("Nothing was ordered.")
                return

            # Saved before it is sent: if the answer is lost, the next run sends
            # this exact request again with the same key, and is never charged twice.
            # expected_charge refuses the order if the price moved since the estimate.
            state = {"checker": args.checker, "idempotency_key": str(uuid.uuid4()),
                     "order_body": {**body, "expected_charge": quote["charge"]}}
            state_path.write_text(json.dumps(state, indent=2))
        elif not state.get("order_id"):
            print("Sending the order from the last run again, with the same Idempotency-Key…")

        if not state.get("order_id"):
            order = call_with_retries("POST", "/orders", key, state["order_body"],
                                      headers={"Idempotency-Key": state["idempotency_key"]})
            state["order_id"] = order["id"]
            state_path.write_text(json.dumps(state, indent=2))
            print(f"Order {order['id']} placed: {order['charge']} {order['currency']}")

        order_id = state["order_id"]
        while True:
            order = call_with_retries("GET", f"/orders/{order_id}", key)
            parts = order.get("parts") or {}
            print(f"  {order['status']} ({parts.get('completed', 0)}/{parts.get('total', '?')} parts)")
            if order["status"] in FINISHED:
                break
            time.sleep(POLL_SECONDS)

        if order["status"] == "failed":
            sys.exit(f"The order failed and {order.get('refunded')} {order.get('currency')} was refunded.")
        if order.get("results"):
            # A count the checker does not report is null.
            print("Summary:", ", ".join(f"{k} {v:,}" if isinstance(v, int) else f"{k} n/a"
                                        for k, v in order["results"].items()))

        files = call_with_retries("GET", f"/orders/{order_id}/results", key)
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        for part in files.get("parts", []):
            if not part.get("url"):
                print(f"  part {part['part']}: {part['status']}, no file")
                continue
            target = out / f"{order_id}-part{part['part']}-{part['file_name']}"
            download(part["url"], target)
            print(f"  saved {target}")
        if order["status"] == "partially_completed":
            print(f"Some parts failed; {order.get('refunded')} {order.get('currency')} was refunded for them.")
    except ApiError as err:
        sys.exit(f"Refused: {err}\nSee https://docs.talismanleads.io/errors")


if __name__ == "__main__":
    main()

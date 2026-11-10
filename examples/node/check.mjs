#!/usr/bin/env node
/**
 * Run a TalismanLeads checker over a list, from start to finish:
 * see the price, place the order, wait for it, and download the result.
 *
 *   export TALISMANLEADS_API_KEY="tl_live_..."
 *   node check.mjs list.txt
 *
 * The list is a .txt file with one entry on each line. Phone numbers are
 * written with their country code, such as +14155550142.
 *
 * No packages to install: Node.js 18.3 or newer.
 * Docs: https://docs.talismanleads.io
 */

import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";

const DEFAULT_CHECKER = "viber_activity_checker";
const API_BASE = (process.env.TALISMANLEADS_API_BASE ?? "https://api.talismanleads.io/v1").replace(/\/$/, "");

// A list this large goes up as a file (POST /uploads) instead of in the request.
const INLINE_MAX_ENTRIES = 100_000;
const INLINE_MAX_BYTES = 3_900_000; // the request's limit is 4 MB; keep a margin

// Statuses after which an order no longer changes. Any other status, including
// one added later, is treated as still running.
const FINISHED = new Set(["completed", "partially_completed", "failed"]);
const POLL_MS = 30_000;
// Refusals that mean "wait and send the same request again". On an order the
// same Idempotency-Key makes the repeat safe: it is never charged twice.
const RETRYABLE = new Set([
  "rate_limited",
  "too_many_open_orders",
  "order_status_unknown",
  "service_unavailable",
  "internal_error",
  "api_disabled",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ApiError extends Error {
  constructor(status, code, message, requestId, retryAfter) {
    super(message);
    Object.assign(this, { status, code, requestId, retryAfter });
  }
  toString() {
    return `${this.code}: ${this.message}${this.requestId ? ` (request_id ${this.requestId})` : ""}`;
  }
}

/** Calls the API and returns the parsed JSON, or throws ApiError. */
async function api(method, path, key, body, headers = {}) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(330_000),
  });
  const text = await res.text();
  if (res.ok) return text ? JSON.parse(text) : {};
  let error;
  try {
    error = JSON.parse(text).error;
  } catch {
    // Not our JSON: a gateway's 502 or 504. For an order this means
    // "unknown", and the same Idempotency-Key settles it.
  }
  if (!error) {
    throw new ApiError(res.status, res.status >= 500 ? "order_status_unknown" : "http_error", `HTTP ${res.status} without a JSON answer`);
  }
  throw new ApiError(res.status, error.code, error.message, error.request_id, res.headers.get("Retry-After"));
}

/** Retries what is safe to retry: rate limits, lost answers and gateway errors. */
async function callWithRetries(method, path, key, body, headers, attempts = 6) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await api(method, path, key, body, headers);
    } catch (err) {
      const retryable = err instanceof ApiError ? RETRYABLE.has(err.code) : true; // network errors too
      if (!retryable || attempt === attempts) throw err;
      const wait = err instanceof ApiError && /^\d+$/.test(err.retryAfter ?? "") ? Number(err.retryAfter) : 60;
      console.error(`  ${err instanceof ApiError ? err.code : err.message}; trying again in ${wait} s`);
      await sleep(wait * 1000);
    }
  }
}

/** Sends a large list straight to storage and returns its upload_id. */
async function upload(path, key) {
  const { size } = await stat(path);
  const link = await callWithRetries("POST", "/uploads", key, { file_name: txtName(path), size_bytes: size });
  // The link carries its own permission: the API key is never sent to it.
  const res = await fetch(link.upload_url, { method: link.method ?? "PUT", headers: link.headers ?? {}, body: await readFile(path) });
  if (!res.ok) throw new Error(`The upload failed with HTTP ${res.status}`);
  return link.upload_id;
}

async function download(url, target) {
  // Download links carry their own permission, so no API key here either.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The download failed with HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(target));
}

const txtName = (path) => basename(path).replace(/(\.[^.]*)?$/, ".txt");

async function main() {
  const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      checker: { type: "string", default: DEFAULT_CHECKER },
      country: { type: "string" },
      yes: { type: "boolean", default: false },
      new: { type: "boolean", default: false },
      out: { type: "string", default: "results" },
    },
  });
  const listPath = positionals[0];
  if (!listPath) {
    console.error("Usage: node check.mjs list.txt [--checker ID] [--country US] [--yes] [--new] [--out results]");
    process.exit(2);
  }
  const key = process.env.TALISMANLEADS_API_KEY;
  if (!key) {
    console.error("Set TALISMANLEADS_API_KEY first. Create a key at https://talismanleads.io/api-keys");
    process.exit(1);
  }

  // The state file keeps the Idempotency-Key and the order id beside the list,
  // so running the script again picks the same order up instead of paying twice.
  const statePath = `${listPath}.order.json`;
  let state = !opts.new && existsSync(statePath) ? JSON.parse(await readFile(statePath, "utf8")) : {};
  if (state.checker && state.checker !== opts.checker) {
    console.error(`${statePath} belongs to an order for ${state.checker}. Use --new to start another.`);
    process.exit(1);
  }
  const saveState = () => writeFile(statePath, JSON.stringify(state, null, 2));

  if (!state.order_id && !state.order_body) {
    const entries = (await readFile(listPath, "utf8")).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const body = { checker: opts.checker, file_name: txtName(listPath) };
    if (opts.country) body.country = opts.country.toUpperCase();
    // The 4 MB limit is on the request, which is larger than the file.
    const requestBytes = Buffer.byteLength(JSON.stringify({ ...body, entries }));
    if (entries.length > INLINE_MAX_ENTRIES || requestBytes > INLINE_MAX_BYTES) {
      console.log(`Uploading ${entries.length.toLocaleString("en-US")} entries…`);
      body.upload_id = await upload(listPath, key);
    } else {
      body.entries = entries;
    }

    const quote = await callWithRetries("POST", "/estimates", key, body);
    console.log(
      `${quote.entries.toLocaleString("en-US")} entries, billed as ${quote.billed_entries.toLocaleString("en-US")}: ${quote.charge} ${quote.currency}`,
    );
    if (!opts.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question("Place the order? [y/N] ")).trim().toLowerCase();
      rl.close();
      if (answer !== "y" && answer !== "yes") {
        console.log("Nothing was ordered.");
        return;
      }
    }

    // Saved before it is sent: if the answer is lost, the next run sends this
    // exact request again with the same key, and is never charged twice.
    // expected_charge refuses the order if the price moved since the estimate.
    state = { checker: opts.checker, idempotency_key: randomUUID(), order_body: { ...body, expected_charge: quote.charge } };
    await saveState();
  } else if (!state.order_id) {
    console.log("Sending the order from the last run again, with the same Idempotency-Key…");
  }

  if (!state.order_id) {
    const order = await callWithRetries("POST", "/orders", key, state.order_body, {
      "Idempotency-Key": state.idempotency_key,
    });
    state.order_id = order.id;
    await saveState();
    console.log(`Order ${order.id} placed: ${order.charge} ${order.currency}`);
  }

  let order;
  for (;;) {
    order = await callWithRetries("GET", `/orders/${state.order_id}`, key);
    const parts = order.parts ?? {};
    console.log(`  ${order.status} (${parts.completed ?? 0}/${parts.total ?? "?"} parts)`);
    if (FINISHED.has(order.status)) break;
    await sleep(POLL_MS);
  }

  if (order.status === "failed") {
    console.error(`The order failed and ${order.refunded} ${order.currency} was refunded.`);
    process.exit(1);
  }
  if (order.results) {
    // A count the checker does not report is null.
    const counts = Object.entries(order.results).map(([k, v]) => `${k} ${typeof v === "number" ? v.toLocaleString("en-US") : "n/a"}`);
    console.log("Summary:", counts.join(", "));
  }

  const files = await callWithRetries("GET", `/orders/${state.order_id}/results`, key);
  await mkdir(opts.out, { recursive: true });
  for (const part of files.parts ?? []) {
    if (!part.url) {
      console.log(`  part ${part.part}: ${part.status}, no file`);
      continue;
    }
    const target = join(opts.out, `${state.order_id}-part${part.part}-${part.file_name}`);
    await download(part.url, target);
    console.log(`  saved ${target}`);
  }
  if (order.status === "partially_completed") {
    console.log(`Some parts failed; ${order.refunded} ${order.currency} was refunded for them.`);
  }
}

main().catch((err) => {
  console.error(err instanceof ApiError ? `Refused: ${err}\nSee https://docs.talismanleads.io/errors` : err);
  process.exit(1);
});

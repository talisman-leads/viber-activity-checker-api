# Viber Activity Checker API

See when each Viber account was last seen online, to focus on active users.

Run the Viber Activity Checker in bulk from your own server with the [TalismanLeads API](https://docs.talismanleads.io): send a list, see the price, place the order and download the result. The same checker is on the [TalismanLeads website](https://talismanleads.io) for lists you would rather upload by hand.

[![API docs](https://img.shields.io/badge/API%20docs-docs.talismanleads.io-0d9488)](https://docs.talismanleads.io/checkers/viber_activity_checker)
[![OpenAPI](https://img.shields.io/badge/OpenAPI-3.1-0d9488)](https://docs.talismanleads.io/openapi.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

| | |
| --- | --- |
| Checker id | `viber_activity_checker` |
| Takes | Phone numbers |
| Billed as at least | 2,000 entries per file |
| Price | [See the live price](https://docs.talismanleads.io/checkers/viber_activity_checker) |
| Base address | `https://api.talismanleads.io/v1` |

## Quick start

1. Create an API key under [API keys](https://talismanleads.io/api-keys) in your TalismanLeads account, and add a balance.
2. Put the key in an environment variable, never in your code:

   ```bash
   export TALISMANLEADS_API_KEY="tl_live_your_key_here"
   ```

3. Run the example over your list. It shows the price and asks before it orders:

   ```bash
   python3 examples/python/check.py my-list.txt
   # or
   node examples/node/check.mjs my-list.txt
   ```

The examples need nothing installed beyond Python 3.8+ or Node.js 18.3+. The result files are saved in `results/`.

### Your list

Phone numbers in international format, one on each line, such as `+14155550142`. At least 90% of the numbers in one file should be from one country; split a mixed list by country. See [`examples/sample.txt`](examples/sample.txt). Up to 100,000 entries go in the request; a larger list (up to 10,000,000 entries and 200 MB) is uploaded first, which the examples do for you.

## How it works

Every checker works the same way, in four calls:

| Step | Call | What it does |
| --- | --- | --- |
| 1 | `POST /estimates` | Counts the entries and works out the price. Charges nothing. |
| 2 | `POST /orders` | Charges your balance and queues the work. |
| 3 | `GET /orders/{id}` | The order's status: `queued`, `processing`, then `completed`, `partially_completed` or `failed`. Ask every 30 seconds or more. |
| 4 | `GET /orders/{id}/results` | A download link for each part of the result, good for 15 minutes. |

### With cURL

```bash
# 1. See what it would cost
curl -X POST "https://api.talismanleads.io/v1/estimates" \
  -H "Authorization: Bearer $TALISMANLEADS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"checker":"viber_activity_checker","entries":["+14155550142", "+12125550187"]}'

# 2. Place the order. Make the key once and keep it: if this times out,
#    send it again with the same $KEY, never a new one.
KEY=$(uuidgen); echo "Idempotency-Key: $KEY"
curl -X POST "https://api.talismanleads.io/v1/orders" \
  -H "Authorization: Bearer $TALISMANLEADS_API_KEY" \
  -H "Idempotency-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"checker":"viber_activity_checker","entries":["+14155550142", "+12125550187"]}'
```

[`examples/curl.sh`](examples/curl.sh) has every step.

### Safe retries

`POST /orders` needs an `Idempotency-Key`: up to 200 ASCII characters with no spaces, such as a UUID. For 7 days the same key means the same order, charged once, so a request that timed out is sent again with the **same** key, never a new one, after waiting a minute. The Python and Node examples keep the key and the request in `my-list.txt.order.json`: run them again after a dropped connection and they pick the same order up. See [Safe retries](https://docs.talismanleads.io/retries).

Send `expected_charge` with the price from the estimate (the examples do) and the order is refused with `price_changed` if the price moved in between.

## The result

When the order is finished, `GET /orders/{id}` gives the counts where the checker reports them, and `GET /orders/{id}/results` gives the files: usually a zip holding `all.csv`, a spreadsheet and text lists, or a single CSV. Columns can be added over time, so read them by name rather than by position.

## Errors and limits

A refusal is JSON with a `code` that never changes, a `message` for people and a `request_id` for support. Act on the `code`: see [Errors](https://docs.talismanleads.io/errors). On `429 rate_limited`, wait the seconds in `Retry-After` and send the same request again. See [Rate limits](https://docs.talismanleads.io/limits).

Keep the key on your server: the API does not accept calls from a web page, and anyone holding the key can spend your balance.

## Related checkers

- [Viber Number Checker](https://github.com/talisman-leads/viber-number-checker-api): Find the numbers that use Viber, for campaigns on the platform.

## More

- [All TalismanLeads checkers on GitHub](https://github.com/talisman-leads)
- [The full API guide and examples](https://github.com/talisman-leads/talismanleads-api)
- [API documentation](https://docs.talismanleads.io): every endpoint, error and limit
- [OpenAPI file](https://docs.talismanleads.io/openapi.json): import it into Postman, Insomnia or a code generator
- [Pricing](https://talismanleads.io/pricing) and [all checkers](https://docs.talismanleads.io/checkers)
- [Get an API key](https://talismanleads.io/api-keys)

## Support

Questions about the API or an order: [support@talismanleads.io](mailto:support@talismanleads.io), with the `request_id` from the answer. Issues are off on this repo, so that every question reaches the support team.

## License

The example code is under the [MIT License](LICENSE). Use of the API is under the [API terms](https://docs.talismanleads.io/terms) and the [Terms of Service](https://talismanleads.io/terms).

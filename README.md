# PayBridge

A sales-engineering demo of Rapyd card payments. The left pane is a merchant's
storefront (three verticals: retail, crypto, gaming) plus its back office; the
right pane is the "engine room" — the real request, signed headers, Rapyd's
response and the webhooks it fires, updating as the SE clicks through.

Every call is real: the page talks to [`rapyd-backend`](../rapyd-backend), a
small signing proxy that holds the Rapyd keys and forwards to Rapyd's sandbox
(or, when unlocked, live) API. No secret ever reaches the browser — the
signature shown in the Request tab is a display-only recomputation
(`js/signing.js`).

Two integration models are demoed side by side:

- **Own Card Fields** — the merchant collects the PAN and calls
  `POST /v1/payments` directly (PCI-DSS path). Sandbox only for raw cards.
- **Checkout Toolkit** — Rapyd's hosted iframe collects the card
  (`POST /v1/checkout`), zero PCI scope for the merchant.

## Running locally

It's a static site — vanilla ES modules, no build step, no dependencies.
Serve the repo root over HTTP (modules don't load from `file://`):

```sh
cd paybridge
python3 -m http.server 8000
# open http://localhost:8000
```

### Backend

The page needs a running `rapyd-backend`. Its origin is read once, at import
time, from a meta tag in `index.html`:

```html
<meta name="paybridge-backend" content="https://rapyd-backend.vercel.app" />
```

Edit that one line to point a staging deploy (or `http://localhost:3000` for
the backend's local Express server) somewhere else. A query parameter is
deliberately **not** honoured — a crafted link could otherwise redirect the
demo, and the live token, to someone else's server. If the backend sets
`ALLOWED_ORIGINS`, the frontend's origin must be in that list.

Webhooks need the backend's KV store and `/api/webhook` registered with Rapyd
for the MID in use; without them the Webhooks tab says so and the demo falls
back to polling `GET /v1/payments/{id}`.

### Hosted checkout return pages

The Checkout Toolkit's hosted mode sends the shopper to this site's own
`complete/` and `cancel/` pages. Rapyd requires https, so when the page itself
is served over plain http (a local run) set the https origin of a deployed
copy in `index.html`:

```html
<meta name="paybridge-public-url" content="https://your-paybridge-deploy.example/" />
```

Left empty, a local run falls back to the legacy `rapydtoolkit.com` URLs,
which currently 404 after the hosted page.

## Deploying

**Deploy `rapyd-backend` first (or together with this site), never after.**
Every POST now carries an `Idempotency-Key` header (and live calls an
`X-PayBridge-Live-Token`). A backend whose CORS preflight only allows
`Content-Type` makes the browser block those requests, so every payment,
checkout session, refund and customer call fails as "Network error". The
backend's preflight must answer
`Access-Control-Allow-Headers: Content-Type, X-PayBridge-Live-Token, Idempotency-Key`
(see `rapyd-backend/README.md`) before this static site ships.

## Sandbox profiles

The Sandbox button opens a picker over three sandbox MIDs (`SC1`–`SC3`,
`js/profiles.js`) that differ in 3DS provider and whether they return a
`network_reference_id`. Switching never resets an in-flight checkout; customer
and stored-credential state is kept per `env:profile` bucket.

## Live mode (restricted)

Live charges a real card. The backend refuses every `env: 'live'` call unless
it has `PAYBRIDGE_LIVE_TOKEN` configured **and** the request carries a matching
`X-PayBridge-Live-Token` header. In the UI:

- Clicking **Live** asks for the live access token. Cancel (or an empty field)
  stays in sandbox.
- The token is kept in `sessionStorage` for this tab only (in memory if storage
  is unavailable). It is never rendered, logged or put in a URL.
- If the backend rejects it (`401 LIVE_AUTH_REQUIRED` / `403 LIVE_DISABLED`),
  the token is cleared, the page drops back to sandbox and a banner explains
  why.
- Every live charge is `0.01`; the backend independently caps amounts
  (`LIVE_MAX_AMOUNT`), refuses raw card data (so Own Card Fields can't send a
  PAN in live) and allowlists body fields.

## Trust model

`/api/webhook` is a public URL, so a webhook only drives state — the success
screen, a ledger settlement, a saved card — when the receiver verified its
Rapyd signature, or when the outcome came from our own signed
`GET /v1/payments/{id}` (`classify.js isTrusted`). A signature alone isn't
enough: anyone can create a sandbox payment that carries our reference and
Rapyd will sign its webhook, so a verified event also has to be signed for the
payment's environment (`verified_env`) and, once the payment id is known, be
about that payment (`classify.js isTrustedFor`). Anything else is still shown
— unverified events with an "unverified — not trusted" chip — and triggers a
Retrieve Payment to confirm. `merchant_reference_id`s carry 64 random bits
(`api.js newReference`), because the reference is also the (unauthenticated)
read key for its stored webhooks. A payment whose create call got no answer
even after the same-key retry is left pending ("Outcome unknown") rather than
shown as declined. Everything rendered into HTML goes through `ui.js esc()`.

## Module map

| File | Role |
| --- | --- |
| `index.html` | Shell: top bar, model sub-bar, the two panes, portals (FX popover, currency dropdown, live dialog, banner). |
| `js/app.js` | Bootstrap: renders the shell, wires controls, price tile + FX popover, sandbox picker, live unlock. |
| `js/state.js` | Tiny reactive store. `vertical`/`model`/`env` changes reset the client flow; most other fields are mutated directly. |
| `js/steps.js` | The client page as four frames (account question → account → product → checkout). |
| `js/identity.js` | Guest / account / returning checkout identity. |
| `js/verticals.js` | Vertical + product catalog, `activeProduct()`, FX-aware customer/merchant amounts. |
| `js/profiles.js` | Sandbox MID registry (public identifiers only). |
| `js/flows/own-fields.js` | Own Card Fields flow. |
| `js/flows/toolkit.js` | Checkout Toolkit flow. |
| `js/flows/shared.js` | Pieces shared by the two client flows. |
| `js/flows/back-office.js` | Merchant back office: session payments, refunds, customer view, MIT charges. |
| `js/customer-beat.js` | `POST /v1/customers` as its own step. |
| `js/customers.js` | Session customer + stored credentials, keyed per `env:profile`. |
| `js/ledger.js` | Session payment ledger + its settlement poller. |
| `js/webhooks.js` | Webhook watcher for the active payment and customer; Retrieve Payment fallback. |
| `js/classify.js` | Webhook classification and the trust rule. |
| `js/screens.js` | Post-payment screens (processing, 3DS, success, error). |
| `js/api.js` | The only network layer: backend wrappers, idempotency keys, live token. Never throws. |
| `js/signing.js` | Display-only request signing + key redaction for the engine room. |
| `js/json-view.js` | Line-numbered, escaped JSON viewer with field↔path highlighting. |
| `js/sync.js` | Field→request-path map, card brand, amount validation, input formatting. |
| `js/ui.js` | `esc()`, tab switching, the status pill. |
| `js/client-details.js` | Browser `client_details` for 3DS. |
| `css/tokens.css` | Design tokens. |
| `css/main.css`, `css/cof.css` | Components. |
| `complete/`, `cancel/` | Landing pages for the hosted checkout's redirect URLs. |
| `tests/` | No-network unit tests (`unit.js`), their browser runner (`index.html`) and the `check_modules.py` import/export checker. |
| `DESIGN-SYSTEM.md`, `design-system.html` | The design system and its specimen page. |

## Tests

There's no Node toolchain on purpose. The browser test harness lives at
`tests/index.html`: serve the repo root as above and open
<http://localhost:8000/tests/> — it runs `tests/unit.js`, which imports the
modules directly (which is why `ui.js`, `api.js`, `sync.js`, `classify.js` and
`ledger.js` do no DOM work at import time) and reports pass/fail in the page.
It covers `ui.esc`, `json-view` escaping, `sync.brandLabel` / `currencyDecimals` / `validAmount`,
`classify.isTrusted` / `isTrustedFor`, `api.newReference` and
`ledger.refundedTotals`, and makes no network calls. The flows themselves are
not unit-tested.

The backend has its own `node --test` suite (`rapyd-backend/tests`).

`python3 tests/check_modules.py` is a no-Node static check of the module graph
across both repos (this one and `../rapyd-backend`). It flags imports of names
a module doesn't export, missing import targets, bad `ns.name` uses on
`import * as ns`, duplicate exports/top-level bindings and unresolvable bare
specifiers, and exits non-zero on any error. Run it after renaming or moving an
export: in the browser those mistakes show up only as a blank page.

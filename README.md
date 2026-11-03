# Rapyd Demo

A sales-engineering demo of Rapyd card payments. The left pane is a merchant's
storefront — one of five Rapyd demo merchants: **rapyd.shop** (e-commerce),
**rapyd.coin** (crypto), **rapyd.spin** (gambling), **rapyd.fx** (forex
trading) and **rapyd.stream** (digital content) — plus its back office;
the right pane is the "engine room" — the real request, signed headers, Rapyd's
response and the webhooks it fires, updating as the SE clicks through. Every SE
control lives in one **demo-controls drawer** (header button, or the `` ` `` key).

The whole UI follows the Rapyd design language (Inter, cool greys, `#7437F5`) —
see `DESIGN-SYSTEM.md`. (The repo and folder keep their historical `paybridge`
name, as do the backend contract's `X-PayBridge-Live-Token` header and the
`paybridge-*` meta tags.)

Every call is real: the page talks to [`rapyd-backend`](../rapyd-backend), a
small signing proxy that holds the Rapyd keys and forwards to Rapyd's sandbox
(or, when unlocked, live) API. No secret ever reaches the browser — the
signature shown in the Request tab is a display-only recomputation
(`js/signing.js`).

Two integration models are demoed side by side:

- **Own Card Fields** — the merchant collects the PAN and calls
  `POST /v1/payments` directly (PCI-DSS path, typically SAQ D). Sandbox only for raw cards.
- **Checkout Toolkit** — Rapyd's hosted iframe collects the card
  (`POST /v1/checkout`): full toolkit, wallet buttons only, or the hosted
  checkout page (typically SAQ A).

### The integration seam

`js/seam.js` is the one description of where the merchant's site ends and Rapyd
begins on each path (who hosts the card form, PCI scope, where redirects
happen); the drawer's Integration path section and the engine room's seam strip
both render it. Inside the browser frame every Rapyd surface — the toolkit
iframe, Rapyd's 3DS challenge, the hosted page — is outlined and tagged
"Rapyd"; the merchant's parts carry no label and Rapyd's surfaces are never
restyled. **Show seam** (drawer, default on) hides the markers for a clean
customer view.

The frame's address bar follows the journey: the merchant's domain and page;
on the hosted path, **Continue to payment** still opens Rapyd's real page in a
new tab, and the frame switches to the session's `redirect_url` host
(`sandboxcheckout.rapyd.net` in sandbox, the live host in live) with a labelled
stand-in; it comes back to `merchant/checkout/complete` (the skinned success
screen, driven by the trusted terminal event as before) or
`merchant/checkout/cancel` (the stand-in's "Back to merchant" link, or the
real `cancel/` page reporting back over a same-origin `BroadcastChannel`). A
decline while the shopper is still on Rapyd's page stays there — Rapyd's
address, the stand-in marked "Declined on Rapyd's page" — because that's what
the shopper really sees; only a decline after they're back lands on the
merchant's checkout.

### External 3DS (simulated)

A MID set up for an external 3DS provider (`SC2`, `js/profiles.js`
`tds: 'external'`) runs the merchant's **own** 3DS first, on Own Card Fields
(`js/ext3ds.js`). Pay opens a neutral issuer page in the frame (its own grey
"Merchant's 3DS provider (simulated)" marker — not the skin, not Rapyd) with
Pass / Fail and a Frictionless shortcut; the engine room shows the
merchant → 3DS-server exchange as a dashed **Simulated** card with dummy
results. A pass sends the real `POST /v1/payments` with
`payment_method_options` `3d_version` / `cavv` / `eci` / `ds_trans_id`
(highlighted in the body; no `3d_required` — the checkout's "Require 3-D
Secure" box is withdrawn on these MIDs). A fail stops before Rapyd: no call,
no ledger entry, a skinned "We couldn't verify this payment with your bank"
decline. The toolkit and hosted page don't apply — Rapyd hosts the card form
there (the seam explainer says so). Field names:
docs.rapyd.net/en/creating-a-card-payment-with-3ds-authentication---external-3ds.html.

### Apple Pay / Google Pay — checkout (real) vs direct (mock token, real sandbox call)

Drawer → Integration path → **Wallet integration**:

- **Checkout (real)** — Apple Pay / Google Pay inside Rapyd's toolkit iframe
  ("Wallet buttons" mode) or hosted page, unchanged: real calls, real sheet.
- **Direct — encrypted (mock token)** — the merchant's own Apple Pay / Google Pay
  buttons on its own checkout (Own Card Fields: above "Pay by card"; Checkout
  Toolkit: in the order summary). The token the wallet sheet returns is
  forwarded unchanged in `payment_method.digital_wallet.details.token`; Rapyd
  decrypts it.
- **Direct — decrypted (mock token)** — the merchant decrypts the token with its
  own keys and sends `details.decrypted_data` (DPAN + cryptogram + ECI) and
  `details.brand_data`. The card is then on the merchant's servers, so it's
  offered on **Own Card Fields only** (disabled with the reason on the toolkit).

Both direct variants are sandbox-only. The wallet side is simulated — no Apple
or Google session; the click opens a neutral, OS-like wallet sheet marked
"Simulated" (grey third-party seam marker) and the token it "returns" is mock
(`SIMULATED-…` strings, base64 that decodes to `SIMULATED-…`, the 4111 test
DPAN). That token then goes to Rapyd **for real**: `POST /v1/payments` through
the backend, in the shape of Rapyd's samples (`capture: true`,
`metadata.digital_wallet`). The Rapyd sandbox accepts mock wallet payloads and
creates a genuine payment against its own test card, so the payment gets a
ledger entry, a webhook watch, Rapyd's 3DS if it asks, and the normal success
screen. Google Pay decrypted has an **authMethod** choice in the drawer
(`CRYPTOGRAM_3DS` / `PAN_ONLY`); its `gatewayMerchantId` must be the
merchant's Rapyd access key, which the browser never holds — the backend
writes it in before signing. The engine room shows the whole sequence —
Apple / Google / merchant steps as one-line boxes *outside Rapyd* with a link
to Apple's / Google's own docs (merchant ID and certificates, merchant
validation, the sheet, gateway vs DIRECT tokenization, token decryption), then
`POST /v1/payments` in full (field guide, 3DS note, body with the wallet's data
highlighted) and Rapyd's response (`js/direct-wallet.js` builds the payloads,
`js/flows/direct-wallet.js` drives the page). The buttons use the wallet's name as text on a black button — no
official Apple / Google artwork is embedded.

Field names: docs.rapyd.net — creating-a-payment-with-apple-pay--encrypted-,
creating-a-payment-with-apple-pay--decrypted-,
creating-a-payment-with-google-pay---encrypted-,
creating-a-payment-with-google-pay---decrypted-,
creating-a-google-pay--payment-on-a-customized-checkout-page and
retrieve-apple-pay-session (`.html`).

### Merchant wallet (deposit / withdraw)

Gambling, forex and crypto merchants run a deposit / withdraw journey, so the
**rapyd.spin** (gambling), **rapyd.coin** (crypto) and **rapyd.fx** (forex)
packs opt in to a **Wallet** page (`js/packs.js` `wallet` rule; rapyd.shop's
home pack keeps it off — its prototype's store credit was refund credit spent
at checkout, not a cash-out balance — and so does rapyd.stream: digital
content has nothing to hold a balance for). Signed-in shoppers see a Wallet nav item:

- **Balance** — the merchant's own ledger of what the shopper holds (store
  credit / a player or trading balance), *not* a Rapyd wallet: deposits land in
  the MID's collection wallet and withdrawals are paid out of it. It is derived
  from this tab's ledger (`js/site/wallet.js walletBalance`): completed deposits
  (only a trusted outcome completes them) minus their refunds minus every payout
  that hasn't failed (in-flight ones are reserved). A withdrawal can never
  exceed the available balance, and amounts pass `validAmount`.
- **Deposit** ("Deposit" for gambling/crypto/forex; "Top up" for a pack that doesn't
  name it) — the amount becomes the checkout's product, so the shopper pays
  through the existing flow on the selected path (own fields, toolkit, express
  saved card, hosted page) with the seam, FX and the live 0.01 clamp as usual.
  Crypto and forex deposits carry the pack's AFT indicators with
  `is_direct_purchase: false` (they fund a balance) — forex with
  `purpose_code: high_risk_securities` only (Rapyd's AFT guide,
  docs.rapyd.net/en/creating-an-aft-payment.html, documents no
  `special_condition_indicator`); gambling deposits carry none, as before.
- **Withdraw** — a real Rapyd **card payout**, four beats in the engine room:
  `POST /v1/cards/eligibility` (`transaction_type: oct`, the card as `card_id`
  or — sandbox — the test card's `card_number`): the card's `issuer_country`
  becomes the payout's `beneficiary_country` and its `billing_currency` the
  `payout_currency`; the pack's `octCategory` verdict
  (`data.oct.<family>_domestic|_international`, domestic when the issuer is in
  the pack's country) set to `not_supported` — or no `issuer_country` — stops
  the withdrawal with the reason on the page and **no payout call**. Then
  `GET /v1/payout_method_types` (category card, issuer country + billing
  currency — picks e.g. `gb_visa_card`), `GET /v1/payout_methods/{type}/required_fields`
  (fills `beneficiary` / `sender`; any required field the demo has no value for
  is named on the card) and `POST /v1/payouts` from the profile's wallet:
  `sender_entity_type: company` (the merchant, in the pack's country),
  `beneficiary_entity_type: individual`, `sender_currency` = the balance
  currency, `confirm_automatically: true`, a `merchant_reference_id` (≤ 45
  chars). When the card bills in another currency Rapyd does the FX: the body
  fixes `sender_amount` (what leaves the balance) instead of `payout_amount`,
  and the engine room says so. The beneficiary is the shopper's
  **saved card** (`beneficiary.card_id = card_***`) or, sandbox only, Rapyd's
  sandbox payout card `4111 1111 1111 1111`. The ledger confirms it from a
  verified `PAYOUT_COMPLETED` / `PAYOUT_FAILED` (signed for the payout's env and
  about its id) or `GET /v1/payouts/{id}`; the create call's own answer counts
  too. The back office lists payouts as their own tiles (click → retrieve).
- **Live:** payouts move real money, so the backend refuses every live payout
  call unless `LIVE_PAYOUTS_ENABLED=true` (default off), then applies the live
  gate, the `LIVE_MAX_AMOUNT` cap on `payout_amount`, its allowlist and no raw
  card (live can only pay out to a saved `card_***`, and check eligibility by
  `card_id`). A live FX payout therefore sends `payout_amount` 0.01 in the
  card's currency, not `sender_amount`.

Payouts need the MID set up for them: card payouts enabled, and funds in the
source wallet's payout currency (sandbox: *Add Funds to Wallet Account*,
`POST /v1/account/deposit`, or the Client Portal) — see `rapyd-backend/README.md`.

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
time, from two meta tags in `index.html`:

```html
<meta name="paybridge-backend" content="https://rapyd-backend.vercel.app" />
<meta name="paybridge-backend-staging" content="https://rapyd-backend-git-staging-rapyd-se.vercel.app" />
```

`staging.rapyd.shop` and Vercel preview deployments (`*.vercel.app`) use the
staging one; every other host (rapyd.shop, localhost) uses the production one
(`js/api.js` `pickBackend`). Edit the production line to `http://localhost:3000`
to run against the backend's local Express server. A query parameter is
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

## The demo-controls drawer

One drawer, toggled by the header button or the `` ` `` key (Esc closes):

- **Customer** — which merchant skin is on screen.
- **Integration path** — Own Card Fields / Checkout Toolkit, the toolkit's
  mode (full toolkit, wallet buttons, hosted page), the **Wallet integration**
  (Checkout (real) / Direct — encrypted / Direct — decrypted, the direct ones
  simulated), and **Show seam** with the path's seam explainer.
- **Account** — Sandbox / Live (live asks for its token first, see below), the
  sandbox credential picker over three MIDs (`SC1`–`SC3`, `js/profiles.js`) with
  their AFT / `network_reference_id` badges, the MID's 3DS provider (Rapyd vs
  external — fixed by the MID; for an external provider, the simulated provider's
  default answer: Challenge / Frictionless / Fail), and the session customer with
  **Forget saved customer**.
- **Payment behaviour** — FX (`requested_currency`, who bears it, the live quote)
  and the stored-credential strategy.

Switching skin, path or environment resets the client flow; switching credentials
never resets an in-flight checkout. Customer and stored-credential state is kept
per `env:profile` bucket.

## Customers across reloads

A **sandbox** session customer is remembered in `localStorage` per `env:profile`
bucket — the `cus_***`, the shopper's name/email and the token cards' metadata
(`card_***`, brand, last4, expiry, `network_reference_id`, intent). Never a card
number or CVV: merchant-vault cards hold the PAN, so they stay in memory and are
not remembered at all. Live customers are never written. On reload the remembered
customer is signed in and its cards are re-read once with
`GET /v1/customers/{id}/payment_methods`. **Forget saved customer** (drawer →
Account) drops it.

The sign-in page also offers **Sign in with a customer ID**: enter any `cus_***`
the active MID can see; the demo fetches it with `GET /v1/customers/{id}` (shown
in the engine room) and adopts it, with its saved cards, as the session customer.

The shopper's **Orders** page lists the signed-in customer's payments ("Your
orders" — ledger entries recorded under that `cus_***`) and this tab's guest
checkouts separately. **Payment methods** syncs once per visit, with a Refresh link.

## Live mode (restricted)

Live charges a real card. The backend refuses every `env: 'live'` call unless
it has `PAYBRIDGE_LIVE_TOKEN` configured **and** the request carries a matching
`X-PayBridge-Live-Token` header. In the UI:

- Picking **Live** (drawer → Account) asks for the live access token. Cancel (or
  an empty field) stays in sandbox.
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
| `index.html` | Shell: header (wordmark + drawer button), the two panes, the demo-controls drawer, portals (currency picker, live dialog, banner). |
| `js/app.js` | Bootstrap: renders the shell, the demo-controls drawer (skin, path, env + credentials, FX, strategy), the price tile, live unlock, the remembered-customer re-sync. |
| `js/state.js` | Tiny reactive store. `vertical`/`model`/`env` changes reset the client flow; most other fields are mutated directly. |
| `js/steps.js` | Router for the merchant site: sign in / register / guest → shop → product → bag → checkout, plus Orders, Payment methods and the Wallet; paints the engine room per page. |
| `js/identity.js` | Guest / account / returning checkout identity. |
| `js/skins.js` | Skins — whose site it is: merchant name, descriptor, domain and the site tokens, applied by `applySkin()` to the browser frame only. Built-in: `ecommerce` (rapyd.shop), `crypto` (rapyd.coin), `gaming` (rapyd.spin), `forex` (rapyd.fx), `content` (rapyd.stream). |
| `js/packs.js` | Industry packs — what the merchant sells: catalog, copy, journey rules (`kycAtSignup`, `wallet`). Built-in: `home`, `crypto`, `igaming`, `forex`, `content`. |
| `js/verticals.js` | Skin × pack composition (`VERTICALS`), `activeProduct()` (a valid bag folds into one product here), FX-aware customer/merchant amounts. |
| `js/site/cart.js` | The bag: lines, minor-unit totals, one-currency + subscription-alone rules, the composite product the flows charge. |
| `js/site/chrome.js` | The site header (wordmark, nav, account, bag) and shared product-tile / money helpers. |
| `js/site/session.js` | The merchant's own sign-in session over the session `cus_***` (no Rapyd call). |
| `js/site/lookup.js` | "Sign in with a customer ID": `GET /v1/customers/{id}` and its engine-room cards; adopts the customer. |
| `js/site/shop.js` | Shop (one-off / subscription tabs), product page, bag page and its checkout blockers. |
| `js/site/wallet.js` | The Wallet's rules (pure): the pack's wallet config, the deposit product, balance arithmetic, withdraw limits + chips, the card-eligibility body + its mapping to the payout's country/currency (`payoutRoute`), payout method-type pick, beneficiary/sender filling, the `POST /v1/payouts` body. |
| `js/site/wallet-page.js` | The Wallet page, its engine-room beats (card eligibility → method types → required fields → payout) and the withdraw orchestration. |
| `js/site/account.js` | Signed-in Orders (the customer's vs this tab's guest checkouts, `ledger.ordersFor`) and Payment methods (stored credentials + the list-payment-methods sync beat, once per visit + Refresh). |
| `js/profiles.js` | Sandbox MID registry (public identifiers only). |
| `js/flows/own-fields.js` | Own Card Fields flow. |
| `js/flows/toolkit.js` | Checkout Toolkit flow. |
| `js/flows/shared.js` | Pieces shared by the two client flows. |
| `js/flows/back-office.js` | Merchant back office: session payments, refunds, customer view, MIT charges. |
| `js/customer-beat.js` | `POST /v1/customers` as its own step. |
| `js/customers.js` | Session customer + stored credentials, keyed per `env:profile`; remembers sandbox customers in `localStorage` (no PAN/CVV, never live). |
| `js/ledger.js` | Session payment ledger (each payment tagged with the `cus_***` it was made under; withdrawals as `kind: 'payout'`) + its settlement poller (payouts confirmed by verified `PAYOUT_*` or Retrieve Payout). |
| `js/webhooks.js` | Webhook watcher for the active payment and customer; Retrieve Payment fallback. |
| `js/classify.js` | Webhook classification and the trust rule. |
| `js/screens.js` | Post-payment screens (processing, 3DS, success, error, hosted cancel). |
| `js/seam.js` | The integration seam per path (`SEAM_PATHS`), seam markers + Show seam, the frame's address bar. |
| `js/direct-wallet.js` | Direct Apple Pay / Google Pay (mock token, real sandbox call): the wallet-integration and Google authMethod choices and where they apply, the obviously-fake encrypted / decrypted payloads, the `POST /v1/payments` body builder and the Apple / Google / merchant step list. |
| `js/flows/direct-wallet.js` | The merchant's own wallet buttons, the simulated wallet sheet, the real sandbox `POST /v1/payments` (ledger, webhook watch, 3DS) and the engine-room sequence. |
| `js/ext3ds.js` | External 3DS (simulated): when it applies, the dummy provider result, the `payment_method_options` block and the call/no-call decision. |
| `js/api.js` | The only network layer: backend wrappers, idempotency keys, live token. Never throws. |
| `js/signing.js` | Display-only request signing + key redaction for the engine room. |
| `js/json-view.js` | Line-numbered, escaped JSON viewer with field↔path highlighting. |
| `js/sync.js` | Field→request-path map, card brand, amount validation, input formatting. |
| `js/ui.js` | `esc()`, tab switching, the status pill. |
| `js/client-details.js` | Browser `client_details` for 3DS. |
| `css/tokens.css` | Design tokens (Rapyd palette, Inter `@font-face`), incl. the site ramp a skin may re-face (scoped to the browser frame). |
| `css/main.css`, `css/cof.css` | Components: header, drawer, checkout, toolkit stage, result screens, engine room, back office, notices · card-on-file surfaces. |
| `css/site.css` | The merchant site (header, shop, bag, account pages), token-only. |
| `assets/` | Inter TTFs (`fonts/`), the Rapyd design-system icon font (`icons/`), the empty-state illustration. |
| `complete/`, `cancel/` | Landing pages for the hosted checkout's redirect URLs; they tell the demo tab over a same-origin `BroadcastChannel`. |
| `tests/` | No-network unit tests (`unit.js`), their browser runner (`index.html`) and the `check_modules.py` import/export checker. |
| `DESIGN-SYSTEM.md`, `design-system.html` | The design system and its specimen page. |

## Tests

There's no Node toolchain on purpose. The browser test harness lives at
`tests/index.html`: serve the repo root as above and open
<http://localhost:8000/tests/> — it runs `tests/unit.js`, which imports the
modules directly (which is why `ui.js`, `api.js`, `sync.js`, `classify.js` and
`ledger.js` do no DOM work at import time) and reports pass/fail in the page.
It covers `ui.esc`, `json-view` escaping, `sync.brandLabel` / `currencyDecimals` / `validAmount`,
`classify.isTrusted` / `isTrustedFor`, `api.newReference`,
`ledger.refundedTotals` / `ordersFor`, the bag (`site/cart.js`), the wallet
(`site/wallet.js` — balance arithmetic, withdraw limits, the deposit product, the payout body), the built-in
skins, the integration seam (`seam.js` paths, the hosted address and the 3DS line), external 3DS
(`ext3ds.js` — the `payment_method_options` block, and a fail never calling Rapyd), the direct
wallet payloads (`direct-wallet.js` — encrypted / decrypted shapes, decrypted refused off the PCI
path, the fake markers), and the remembered-customer persistence (`customers.js` serialize /
restore — never a PAN/CVV, never live — against an in-memory storage stand-in),
and makes no network calls. The flows themselves are not unit-tested.

The backend has its own `node --test` suite (`rapyd-backend/tests`).

`python3 tests/check_modules.py` is a no-Node static check of the module graph
across both repos (this one and `../rapyd-backend`). It flags imports of names
a module doesn't export, missing import targets, bad `ns.name` uses on
`import * as ns`, duplicate exports/top-level bindings and unresolvable bare
specifiers, and exits non-zero on any error. Run it after renaming or moving an
export: in the browser those mistakes show up only as a blank page.

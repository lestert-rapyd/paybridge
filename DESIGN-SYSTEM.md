# Rapyd Demo — Design System

**The one reference for how Rapyd Demo looks, sounds and behaves**, so every surface reads as
one Rapyd product. It describes what ships — `css/tokens.css` · `css/main.css` · `css/cof.css` ·
`css/site.css` and the markup the modules produce. Change a primitive → update this file in the same
commit. **`design-system.html`** is the visual half: specimens of every primitive under the real
stylesheets.

> **Single source of truth.** Every colour, face, shadow and radius originates in
> **`css/tokens.css`**. The other stylesheets reference tokens and never hardcode a hex that
> duplicates one. Sanctioned literals: `#fff`/`#000`, the card-scheme marks (Visa `#1a1f71`,
> Mastercard `#eb001b`), white glyph text on a product gradient tile, and the 3DS iframe's white
> backing.

---

## 1. One language, three jobs

Rapyd Demo is a split screen: one action on the **left** produces a visible, truthful consequence on
the **right** (request body, response, webhook, console line). The whole tool speaks **Rapyd's design
language** — Inter, cool greys, Rapyd purple `#7437F5`, white cards with 1px `#EAEBEC` borders and
soft shadows, 8–14px radii, the Rapyd icon font. Three jobs share it:

| | What | Ground | Type |
|---|---|---|---|
| **Tool chrome** | header, demo-controls drawer, back office, dialogs, banner | light — `--app-bg`, white cards | Inter |
| **Merchant site** | the shopper's storefront inside the browser frame (`.browser`) | light — the **site ramp**, which a skin may re-face | `--font-site` (Inter by default) |
| **Engine room** | `.pane-right`: request, response, webhooks, console | **dark** for code legibility — Rapyd's palette on a purple-tinted near-black (`--eng-*`) | Inter for UI text, the system mono for code |

SE-only controls that sit *on* the left (the toolkit config panel) are drawn like the drawer's cards —
tinted `--soft`, a dashed border, real config keys in mono — so they never read as the shopper's page.

## 2. Colour — `css/tokens.css`

### 2.1 Brand
`--accent #7437F5` (fills, active indicators) · `--accent-ink` (accent as text; must pass 4.5:1 on
white) · `--on-accent #fff` · `--accent-soft #F6F2FF` (soft buttons, selected rows) ·
`--accent-soft-2 #EBE7FF` (focus ring) · `--accent-hover #E8DEFF` (soft-button hover) ·
`--link #4877EF` / `--link-hover #6D92F2`.

### 2.2 Neutrals (light)
| token | value | use |
|---|---|---|
| `--ink` | `#2A2A2B` | headings, amounts, primary text |
| `--text` | `#454545` | body, labels |
| `--muted` | `#727272` | secondary copy, subtitles, eyebrows |
| `--faint` / `--field-strong` | `#A1A1A1` | placeholders, meta · hovered input border |
| `--field` | `#CECECE` | input / control borders |
| `--line-2` | `#D7D8DB` | kbd chips, browser dots, switch track |
| `--line` | `#EAEBEC` | card borders, hairlines |
| `--soft-3` | `#F6F6F7` | hover fill |
| `--soft-2` / `--app-bg` | `#F1F2F3` | app background, segmented tracks, url bar |
| `--soft` | `#FBFBFB` | drawer body, tinted panels, browser chrome |
| `--surface` | `#FFFFFF` | cards |

### 2.3 Semantic
`--ok/-deep/-soft`, `--warn/-deep/-soft`, `--err/-deep/-soft`, `--info/-soft`. On light ground text
uses the `-deep` step on the `-soft` fill (status badges, notices). Never put the engine room's bright
set on light ground.

### 2.4 Engine room
`--eng-bg #121019` · `--eng-surface #1A1724` · `--eng-surface-2 #231F30` · `--eng-line #2D2840` ·
`--eng-text #F3F1F9` · `--eng-muted #A19CB5` · `--eng-faint #6F6A86` · `--eng-accent #9D78FA` (the
purple that reads on dark: active tab rule, spinner). Status on dark: `--eng-ok/-err/-warn/-info`.
Syntax: `--syn-key/-str/-num/-bool/-punc`; field↔JSON highlight `--sync-hl` / `--sync-edge`. The
engine room is the same in every skin — it's Rapyd's, not the merchant's.

### 2.5 The site ramp and skins
The merchant site paints with the same ramp names (`--ink … --soft-2`, `--accent*`). In
`tokens.css`, `.browser` folds the **skin tokens** — `--site-ink`, `--site-text`, `--site-muted`,
`--site-faint`, `--site-line`, `--site-field`, `--site-soft`, `--site-soft-2`, `--font-site`,
`--font-site-display` — into those names, falling back to the Rapyd values. `js/skins.js applySkin()`
writes a skin's tokens (and the accent set) **onto the `.browser` element only**, so a customer skin
recolours the storefront and nothing else: the header, drawer, engine room, back office and dialogs
stay Rapyd. Inside the frame the **integration seam** still holds — the toolkit iframe, the hosted
page and Rapyd's 3DS challenge render as Rapyd ships them and are never styled.

## 3. Type

Inter everywhere (self-hosted `@font-face` in `tokens.css`, `assets/fonts/`; no web-font CDN), the
system mono (`--font-mono`: ui-monospace / SF Mono / Menlo) for code, ids, amounts in the engine room,
API parameter names and the currency picker.

| role | size / weight |
|---|---|
| site page title `.site-h1` | 34 / 600, −0.02em (checkout 30) |
| result title `.screen-title` | 34 / 600 |
| subtitle `.site-sub` | 17 / 300, `--muted` |
| card title / drawer card title | 14–15 / 600 |
| body, labels | 13–14 / 400–500 |
| eyebrow / section label | 11 / 600, +0.08em, uppercase, `--muted` |
| engine-room code | 12 mono, line-height 1.7 |

## 4. Space, shape, elevation, motion

Radii: `--r-xs 4` (kbd, tags) · `--r-sm 6` (segmented buttons, chips) · `--r-md 8` (inputs, buttons,
engine cards) · `--r-lg 12` (cards, drawer cards, tiles) · `--r-xl 14` (browser frame, dialogs) ·
`--r-pill`. Elevation: `--shadow-sm` (segment thumb), `--shadow-card` (back-office cards),
`--shadow-pop` (browser frame, popovers, dialogs), `--shadow-drawer`. Motion is small and quick:
120–180ms colour/transform transitions, the drawer slides 24px in, result badges pop.

## 5. Components (reuse before inventing)

**Buttons.** One primary per screen: `.co-cta` (accent fill, 8px, 48–50px tall). Secondary:
`.cs-secondary` (white, 1px line). Soft: `.site-btn-soft`, `.bo-cof-sync`, `.dc-btn` (accent text on
`--accent-soft`; `.dc-btn.danger` on `--err-soft`). Links: `.use-test`, `.cof-link`, `.site-link-btn`
(link blue / accent-ink). Disabled = 45–55% opacity + `not-allowed`, and a control that explains why
carries its own reason (title or adjacent note).

**Fields.** `.co-input` wraps an `<input>`: 48px, 1px `--field`, 8px; hover `--field-strong`; focus
accent border + 3px `--accent-soft-2` ring; `.is-invalid` red. Card fields are mono; names are UI face.
The price tile's `.tile-field` reads as text until hovered; `.input-invalid` gives it a persistent ring.

**Segmented controls.** `.dc-seg`, `.co-fx-seg`, `.tkc-seg`, `.se-seg`, `.cof-dp` share one grammar:
a `--soft-2` track, 6px buttons, the active one a white thumb with `--shadow-sm`.

**Switches.** `.dc-switch` / `.tkc-switch`: 36×20, `--line-2` off, accent on.

**Cards & rows.** White, 1px `--line`, 12px (`.dc-card`, `.bo-tile`, `.bo-detail-card`, `.bo-cof-card`,
`.ord-row`, `.pm-row`, `.bag-sum` tinted). **Route cards** (`.bo-route`) are answers with a consequence
— refund routes, the sign-in page's "Create an account / Continue as guest"; active = accent border on
`--accent-soft`. **Option rows** (`.dc-option`) are the drawer's radios — skins, credentials.

**Badges & pills.** Site: `.ord-badge.ok/.info/.bad/.mute`, `.shop-badge`. Drawer: `.dc-pill`,
`.cred-flag.on/.off`. Engine room: `.method-pill.post/.get/.put/.delete`, `.beat-state`, `.wh-pill`,
`.wh-verify` (unverified events: solid warning chip + dashed `.wh-card.untrusted`).

**Engine room.** `.beat-card` — one collapsible `<details>` per API call (open state owned by
`customer-beat.js`), method pill + path + state badge; `.req-headers` grid; `.jsonv` line-numbered
JSON with `.sync-hit` rows; `.wh-card` webhooks with a semantic left edge; `.tk-console` lines; the
status pill `.status-ind` is the heartbeat.

**Notices.** `.pb-notice` (+ `.warn/.error/.info`) — the one inline callout, light by default,
restated on the dark ramp in the engine room. `#pb-banner` pins one under the header.

**Overlays.** The **demo-controls drawer** (`#demo-drawer`, §5.1), the currency picker
(`#cur-dropdown`, above the drawer), the live dialog (`#live-dialog`, above both, `--scrim`), the
banner, the toast.

### 5.1 The demo-controls drawer
One drawer holds every SE control. Toggle: the header button (which states the context —
merchant · integration path · env/credential) or the **`` ` ``** key (ignored while typing); **Esc**
closes (innermost first: the live dialog, then the currency picker, then the drawer). 400px, fixed to
the right edge, white head with the Rapyd sandbox icon and the `` ` `` key chip, `--soft` body of white
cards, four sections:

1. **Customer** — whose site: the skins as option rows (merchant, industry, domain).
2. **Integration path** — Own Card Fields (SAQ D) / Checkout Toolkit (SAQ A), the path's one-line
   description (the live restriction in `--warn-deep` when live), for the toolkit its
   `integration_mode`: Full toolkit / Wallet buttons / Hosted page (mirrored with the config panel),
   and the **Show seam** card (§5.3) with the path's seam explainer.
3. **Account** — Sandbox / Live (Live opens the live-token dialog when this tab has no token), the
   SC1–SC3 credentials with redacted keys and AFT/NRID badges, the MID's **3-D Secure provider**
   (Rapyd vs External — fixed by the MID, never switchable; for External a "Provider answers"
   segment, Challenge / Frictionless / Fail, presets the simulated provider — §5.4), and the
   **session customer** with "Forget saved customer".
4. **Payment behaviour** — FX (`requested_currency`, who bears it, the live quote preview — quoted only
   on the checkout page) and the stored-credential strategy (`save_payment_method`, `recurrence_type`,
   reuse mode). The price tile's FX badge and the checkout's "Strategy" chip open the drawer here.

It only re-homes existing controls; skin, path and env stay RESET_KEYS (a flow reset), everything else
is a direct mutation with targeted repaints, so an in-flight checkout survives.

### 5.2 The merchant site
Generic across skins (`js/site/`): header (wordmark `name.tld` with the accented TLD, Shop / Orders /
Payment methods, the shopper's first name, the bag), sign-in (email + decorative password, "New here?"
route cards, and **Sign in with a customer ID** — a disclosure that fires `GET /v1/customers/{id}`),
the account form, shop (Products / Subscriptions), product page, bag (its rules surface as
`.site-alert`), checkout, result screens, **Orders** (two groups: "Your orders" — payments recorded
under the signed-in customer's `cus_***`; "Guest checkouts this session") and **Payment methods** (synced
once per visit, with a Refresh link). Product imagery is a hatched `.ph` placeholder.

**Wallet** (signed-in, only when the pack's `wallet` rule is on — gambling and crypto; nav item between
Orders and Payment methods): the balance card (`.wal-balance`, accent-soft fill), Activity rows
(`.wal-row` — `icon-cash_in` on `--ok-soft` for deposits, `icon-cash_out` for withdrawals, a struck-through
amount when it failed) and the Deposit / Withdraw panel (`.wal-panel`: segmented `.wal-tabs`, the amount
field with its ISO code, pill `.wal-chip`s, radio `.wal-dest` rows for "Withdraw to", the CTA and a
`.wal-result` status block — info / ok / err soft fills). The deposit verb follows the pack ("Deposit";
"Top up" when the pack doesn't name one). Deposit hands off to the normal checkout ("Back to wallet" on
its rail; the receipt's primary action is "Back to wallet"); Withdraw stays on the page.

### 5.3 The integration seam (`js/seam.js`)
Where the merchant's site ends and Rapyd begins, per path — one source of truth (`SEAM_PATHS`) read by
the drawer's Show seam card and the engine room's collapsible **seam strip** (between the tabs and the
panels: path · SAQ tag; open → card form / PCI / redirects, then Merchant vs Rapyd surfaces).

- **Markers.** Every Rapyd surface in the frame — the toolkit iframe (`#rapyd-checkout`), Rapyd's 3DS
  challenge, the hosted page's stand-in — is wrapped in `.seam-rapyd`: a 1.5px dashed `--rapyd`
  outline plus a "Rapyd · …" pill tag, drawn **around** the surface. Nothing styles inside it. Merchant
  surfaces (including a custom pay button) carry no mark. `--rapyd` is Rapyd's purple and is never
  re-faced by a skin — the frame's `--accent` is the merchant's.
- **Show seam** (drawer, default on) toggles `.browser.seam-on`; off gives a clean customer view. CSS
  only — a live iframe is never re-rendered.
- **Address bar.** The frame's URL follows the journey: `merchant.tld/<page>` on the site; the
  session's `redirect_url` host (e.g. `sandboxcheckout.rapyd.net/?token=…`) while the hosted page is
  up — the bar gets the Rapyd outline and a "Rapyd" pill; `merchant.tld/checkout/complete` or
  `/checkout/cancel` on return (the merchant's skinned result / cancelled screens).
- **Hosted decline.** A decline while the shopper is on Rapyd's page keeps the frame there (Rapyd's
  address, the stand-in titled "Declined on Rapyd's page"); its back link still returns to the
  merchant's cancel page. Only a decline after the return lands on the merchant's checkout.
- **Hosted stand-in** (`.hp-*`). Rapyd's real page opens in a new tab; the frame shows a neutral
  stand-in in the demo's fixed greys (not the skin, not a copy of Rapyd's page) with "Reopen payment
  page ↗" and "‹ Back to merchant" (what Rapyd's back link does — `cancel_checkout_url`).


### 5.4 External 3DS (`js/ext3ds.js`) — simulated
On a MID with an external 3DS provider (SC2), Own Card Fields' Pay runs the merchant's own provider
before any Rapyd call.

- **Provider page** (`.x3ds-*`, `screens.js renderExternal3DS`). An issuer page on the issuer's domain
  (`acs.example-bank.test`): white card, fixed neutral greys and a slate `#334155` accent after the
  storefront prototype's 3DS screen — never skin tokens, never `--rapyd`. "Verified by Example Bank",
  a SIMULATOR tag, merchant / amount / card facts, **Fail** / **Pass**, and a "Frictionless" text
  link. With the drawer preset on Frictionless or Fail it shows "Checking with your bank…" and answers
  itself. Its seam marker is `.seam-ext` — a grey dashed outline + grey "Merchant's 3DS provider
  (simulated)" pill, under Show seam like the Rapyd ones, never the Rapyd marker.
- **Engine room.** A `beat-card.sim` (dashed edge, amber `3DS` pill, **Simulated** badge) above the
  payment: "Outside Rapyd — the merchant's own 3DS server", the AReq (masked PAN) and the dummy result
  (EMV names), then either the Rapyd-field mapping or "No POST /v1/payments". The four injected
  `payment_method_options` rows carry `.inject-hit` (amber edge; legend `.inject-key`) — a separate
  class from focus's `.sync-hit`.
- **Fail.** The merchant's skinned decline with "We couldn't verify this payment with your bank"; the
  payment card reads "not sent", the response panel says no request was made; no ledger entry.

## 6. Voice: the shopper / SE split (a hard rule)

Two audiences share the screen.
- **Shopper-facing** (inside `.browser`): plain human copy, no API jargon — "Save card for future
  purchases", "Buy BTC now". No identifiers (`cus_***`, `card_***`, `payment_***`), no endpoints, no
  scheme vocabulary (vault, token, PAN, MIT/CIT, NRID), no status codes, no raw gateway errors, no
  control whose only purpose is to fire a call.
- **SE-facing** (the drawer, the engine room, the toolkit config, the back office): label each control
  with the real API key in mono — `save_payment_method`, `require_card_cvv`. A control may name its
  own parameter; it may not teach (no paragraphs about which call a field belongs to).

Two sanctioned crossings: SE chips on the shopper's page that *open the drawer* (the FX badge, the
"Strategy" chip) and `#offstage` (the bank-app mock below the frame, which may name
`statement_descriptor`). "Sign in with a customer ID" asks for a `cus_…` by necessity — the
reason it exists is the SE's line.

## 7. Interaction laws (locked)

1. **Left-tab persistence** — Client Site ⇄ Back Office only toggles visibility; a mid-3DS challenge
   resumes exactly. Non-checkout pages redraw on return (they're stateless).
2. **Right-panel choreography** — prepared body → Request, fire → Response, event → Webhooks, toolkit
   lifecycle → Console. A page change never steals the tab.
3. **ISO codes only** — `149.00 GBP`, never `£149`. FX's varying side is `≈`; unknown is `CUR …`.
4. **Live, honest request bodies** with a real recomputed (display-only) signature.
5. **Trusted events drive outcomes** — a signature-verified webhook for the payment's env and id, or our
   own Retrieve Payment. Unverified events are shown, never acted on.
6. **Redaction** — keys via `signing.js redactKey()` (`rak_ABC***XYZ`); the live token is never rendered.
7. **Surface guards** — paint functions check `state.leftView` / the step before writing shared DOM;
   sequence counters stop a slow response clobbering a newer one.
8. **Don't clobber a form mid-edit.**
9. **Field↔JSON sync** — every editable control that writes the body registers in `js/sync.js FIELD_MAP`.
10. **Escape everything** — every API / user / catalog value interpolated into HTML goes through
    `ui.js esc()`.
11. **Remembered customers are sandbox metadata only** — `cus_***`, name, email and token-card metadata
    in `localStorage` per `env:profile`; never a card number or CVV, never a live customer.

## 8. Naming

| prefix | area |
|---|---|
| `topbar` / `brand` / `drawer-btn` / `live-flag` | app header |
| `dc-` | demo-controls drawer (`dc-sec`, `dc-card`, `dc-option`, `dc-seg`, `dc-switch`, `dc-pill`, `dc-btn`) |
| `cred-` | credential flags inside the drawer |
| `site-` / `sh-` / `shop-` / `pdp-` / `bag-` / `ord-` / `pm-` | the merchant site |
| `co-` | checkout order, totals and fields |
| `id-` / `acct-` / `cof-` | identity question, account block/row, card-on-file |
| `se-` / `sc-` | stored-credential strategy (rendered in the drawer) |
| `fx-` / `cur-` | FX preview + the currency picker |
| `tk-` / `tkc-` | toolkit stage + its config panel |
| `screen-` / `cs-` / `bank-` / `tds-` | result screens, result badge, bank-app mock, 3DS |
| `x3ds-` / `seam-ext` | the external 3DS provider's simulated page and its marker |
| `bo-` | back office |
| `req-` / `eng-` / `beat-` / `jsonv` / `wh-` / `cl-` | engine room |
| `sim-` / `ext-` / `inject-` | simulated (outside-Rapyd) cards, injected-field highlight |
| `pb-` | notices, banner |
| `ds-` | `design-system.html` page chrome only |

Delegation roots (`#checkout`, `#backoffice`, `#demo-drawer`, `#cur-dropdown`) are never destroyed —
only their innerHTML is rebuilt — so listeners are wired once.

## 9. Adding a skin (a customer merchant)

Add an entry to `js/skins.js` (`id`, `label`, `pack`, `merchant`, `descriptor`, `domain`, `tokens`) and
its id to `SKIN_ORDER`. Tokens are data — accent set, optional `--font-site*`, optional `--site-*`
neutrals; omitted ones fall back to Rapyd. Point `pack` at an industry in `js/packs.js` (or add one:
catalog, copy, `kycAtSignup`). Layout never forks per skin. Keep the built-in ids `ecommerce`,
`crypto`, `gaming` stable — the ledger, credentials and back office key on them.

## 10. History

- **2026-10 — merchant wallet.** The Wallet page (`js/site/wallet.js` rules, `wallet-page.js` page and
  beats; `.wal-*` in `site.css`), deposits through the existing checkout, withdrawals as real card
  payouts (three engine-room beats; PAYOUT_* events as a webhooks section), payout tiles in the back
  office (`.bo-tile.clickable-payout`).

- **2026-10 — external 3DS (simulated).** `js/ext3ds.js`, the issuer page (`.x3ds-*`, `.seam-ext`), the
  engine room's Simulated card (`.beat-card.sim`, `.inject-hit`), the drawer's live 3DS card, the
  seam's 3DS line, the hosted decline that stays on Rapyd's page.
- **2026-10 — integration seam.** `js/seam.js`, `.seam-rapyd` markers + Show seam, the engine room's
  seam strip, the hosted redirect played in the address bar, the merchant's cancelled screen,
  `--rapyd` / `--rapyd-soft`.
- **2026-10 — Rapyd rebrand.** The tool became *Rapyd Demo*; the whole UI moved to the Rapyd design
  language (Anton/Epilogue/Hanken Grotesk and the warm greys retired — Inter covers every role, the
  system mono covers code, so nothing loads from a font CDN). The header pills, env switch +
  credential popover, model sub-bar and the FX / strategy popovers merged into the demo-controls
  drawer. Built-in skins became rapyd.shop / rapyd.coin / rapyd.spin (the `rapydshop` skin merged into
  `ecommerce`; the `retail` pack, only it used, deleted). Skins now paint the browser frame only.
  Dead CSS removed with the old shell: the vertical pills, sub-bar, env switch, credential popover,
  FX/strategy popovers, the step rail, the four-frame product chooser (`prod-*`, `frame-block*`).
- **2026-10-07 — security audit.** Live gate + dialog + banner, `.input-invalid`, trusted-events-only,
  one escape helper, `.pb-notice`.
- **2026-08-27 — storefront/engine-room contract.** API narration came off the left pane; a control
  may name its own parameter but not teach.
- **2026-07-25 — token consolidation** into a single `tokens.css`.

# PayBridge — Design System

**The single reference for how PayBridge looks, sounds and behaves**, so every new
surface reads as one product. It *describes what ships* — extracted from and kept in sync with
`css/tokens.css` · `css/main.css` · `css/cof.css` + the flow markup. When you change a primitive,
update this file in the same commit.

> **Single source of truth.** Every colour, type family, shadow and radius the UI paints
> originates in **`css/tokens.css`**. `main.css` / `cof.css` reference those tokens and **must not
> hardcode a hex that duplicates a token value.** The only sanctioned literals are justified
> one-offs — pure `#fff`/`#000`, the macOS window dots, card-brand marks (Visa/Mastercard), the
> bank-app mock's blue, and a few on-light semantic tints — all called out in §2.6.

> **Reading the shipped CSS.** `css/*` is read-blocked in some sessions (writes still work). Read the
> committed copy with `git show HEAD:css/<file>`, the `$TMPDIR/paybridge-preview/css` mirror, or
> `document.styleSheets` on the running preview.

**How to use.** Before building or restyling any surface: (1) pick the **layer** (§1), (2) reuse an
existing **component** (§5) rather than inventing one, (3) obey the **voice split** (§6) and the
**interaction laws** (§8). If nothing fits, compose from **tokens** (§2–4) and add the new class
next to its siblings using the naming convention (§9).

---

## 1. The three layers + chrome (the core mental model)

PayBridge is a split screen. One action on the **left** always produces a visible, truthful
consequence on the **right** (request-body edit, response, webhook, console line). Their visual
identities deliberately differ — that contrast is the demo's main teaching device.

| | Role | Surface | Type | Feel |
|---|---|---|---|---|
| **A · Client surface** `.pane-left` | The client's site / back office — a believable shop | Warm paper `--c-bg`, cards `--c-card` | **Hanken Grotesk** (`--font-client`), headings 800 | Friendly, tactile, brand-forward |
| **B · Engine room** `.pane-right` | The live API: request, response, webhooks, console | Per-vertical **dark** `--eng-bg` | **JetBrains Mono** (all data) + Hanken on tab chrome | Technical, precise, monospace-honest |
| **C · SE config** (inside the left) | Developer configuration disguised as natural UI | Near-black violet `--se-bg` | Human label + mono API param | "The merchant's code" — the one sanctioned dark-on-light crossover |
| **Chrome** `.topbar` / `.subbar` | The app shell that frames both panes | Near-black warm brown `--chrome-bg` | Epilogue (`--font-chrome`) | Neutral frame, invariant across verticals |

The **accent** is the only strong hue on a surface; it swaps per vertical (§2.4). Everything below is
tagged **[A]** client, **[B]** engine, **[C]** SE, **[chrome]**, or **[both]**.

Layer C rules (they keep new flows clean): edit values **in place** where they exist in the client UI
(`.tile-field`); config with no natural home hangs off its element as a **corner bubble**
(`.fx-trigger`) opening a portalled popover; pre-render developer config is the **dark panel**
(`.tk-config`, `--se-*`); **always name the real API param** in mono.

---

## 2. Colour — `css/tokens.css`

### 2.1 Client surface ramp [A] — `--c-*`
The canonical warm-paper ramp. Card titles/amounts ride the darker ink steps; body/labels the mid
steps; eyebrows the lightest.
```
--c-bg #e9e6df  --c-card #fff  --c-soft #faf8f4  --c-soft-2 #f4f2ee  --c-fact #fdfcfa
--c-line #efece5  --c-line-2 #eeebe4  --c-line-3 #e6e2da  --c-line-4 #cfcabf
--c-ink #191714  --c-ink-2 #211e19  --c-ink-3 #3f3b34  --c-ink-4 #5b564d
--c-ink-5 #94908a  --c-ink-6 #a29d93  --c-ink-7 #a8a297  --c-ink-8 #8a857b
```
*Legacy aliases* `--paper --surface --surface-2 --line --line-2 --ink --ink-2 --ink-3 --ink-4` are
retained at their original values for the base layer (left tabs, panel eyebrow, back-office
structure). **New client surfaces should use `--c-*`.**

### 2.2 App chrome [chrome] — `--chrome-*`
The top/sub bars — a near-black warm brown, invariant across verticals (unlike the engine room,
which tints). `--chrome-bg #100b0a` · `--chrome-bar #1a1512` · `--chrome-inset #1c1613` ·
`--chrome-active #2c2622` · `--chrome-pill-active #302722` · `--chrome-tag-bg #3a322c` ·
`--chrome-text #f7f3ec` · `--chrome-text-2 #b3aca1` · `--chrome-text-3 #cfc8bd` · `--chrome-muted #9b948a`.

### 2.3 SE config panel [C] — `--se-*`
Near-black violet dev-code surface. `--se-bg #100f16` · `--se-surface #1a1824` ·
`--se-surface-2 #2c2942` · `--se-line #2a2740` · `--se-line-2 #211f2c` · `--se-text #fff` ·
`--se-title #c7c2e0` · `--se-muted #8681a0` · `--se-faint #6f6a86` · `--se-faint-2 #5a5670`.

### 2.4 Per-vertical accent (set on `<html data-vertical>`) [both]
The accent is the ONLY strong hue on a surface. It swaps per vertical; **never hard-code it**.
| vertical (`data-vertical`) | `--accent` | `--accent-2` | `--accent-soft` | `--on-accent` |
|---|---|---|---|---|
| Retail (`ecommerce`) | `#5600ef` | `#a855f7` | `#efe8ff` | `#fff` |
| Crypto (`crypto`) | `#00e07a` | `#00ff89` | `#daffed` | `#00140a` |
| iGaming (`gaming`) | `#ff007a` | `#ff5ca8` | `#ffe1ee` | `#fff` |

- **Gradient** (CTAs, thumbs): `linear-gradient(100–135deg, var(--accent), var(--accent-2))`.
- **`--accent-soft`** = the tint for selected/active states on light surfaces (chips, route cards,
  segmented buttons). **`--on-accent`** = text/icon on an accent fill — **note it's near-black on
  crypto**; always use the token. (A literal `#fff` glyph, e.g. `.co-thumb`, that must stay white on
  every vertical is deliberately *not* `--on-accent`.)
- Selected-but-subtle uses `color-mix(in srgb, var(--accent) 7–12%, #fff)` (see `.bo-route.active`).

### 2.5 Engine room [B] — `--eng-*` (tinted per vertical)
`--eng-bg / --eng-surface / --eng-surface-2 / --eng-line / --eng-text / --eng-muted / --eng-faint` —
each a desaturated shade of the vertical hue so the engine room feels tinted, not neutral black
(Retail `#0f0a17`…, Crypto `#0a0e0c`…, iGaming `#120410`…). The dark pane also paints a **bright
on-dark status set**: `--eng-ok #4fd08a` · `--eng-err #ff8a8a` · `--eng-warn #f0b45c` ·
`--eng-info #6fa8ff` (pills, the status heartbeat, console tags, response codes).

### 2.6 Semantic + code syntax [both]
```
--ok #12b76a (engine green)   --ok-ui #22a55a (client badge/free)   --ok-deep #159149 (client text)
--warn #f59e0b   --err #ef4444   --err-deep #b91c1c   --info #3b82f6
JSON: --syn-key #8ab4ff  --syn-str #86e1a0  --syn-num #f6c177  --syn-bool #c39bff  --syn-punc #6b7391
highlight: --sync-hl rgba(246,193,119,.14) / --sync-edge #f6c177
```
Never use the engine `--ok` on light ground — use `--ok-ui` / `--ok-deep`. Status tints use an
`rgba()` of the semantic hue at ~14–16% alpha; those alpha tints stay as `rgba()` literals.

**Sanctioned literals** (not tokens): `#fff`/`#000`; macOS dots `#ff5f57/#febc2e/#28c840`;
Visa `#1a1f71`, Mastercard `#eb001b/#f79e1b`; bank-app blue `#e8ebfd/#4f6bed/#f1ecff`; and a handful
of on-light semantic tints (`#1c8a4c/#c62828/#a56a0a/#9a3b3b/#c0392b`) + their callout backgrounds.

---

## 3. Typography

**Families** (`--font-*`): `--font-brand` (**Anton** — the brand wordmark ONLY, `.brand-word`) ·
`--font-client` (**Hanken Grotesk** — all Layer A UI) · `--font-chrome` (**Epilogue** — the app
shell) · `--font-mono` (**JetBrains Mono** — all code/data/keys). Legacy aliases `--font-display`
(→ brand) and `--font-sans` (→ chrome) remain for older rules; don't add new uses.

**Rule of thumb:** any value that is *data the API sees* — amounts, IDs, keys, JSON, `code` labels —
is **mono**. Everything human is proportional (Hanken on the left, Epilogue on the chrome).

| usage | size / weight |
|---|---|
| Storefront H1 `.screen-title` | 37px / 800 / `-0.025em` (Hanken) |
| Card heading `.co-merchant`, product name | ~15–27px / 700–800 |
| Storefront CTA `.co-cta` | 16px / 700 |
| Eyebrow `.panel-eyebrow`, `.eng-label` | 10–11px / 700 / **uppercase** / `+0.09–0.13em` |
| Pills / keys `.wh-pill`, `.hk`, `code` | 10–11.5px mono / 700 |
| Field label `.co-field label` | 13px / 600, `--c-ink-3` |

Uppercase + wide tracking = a *label/eyebrow*. Mono + uppercase = an *engine-room label*. Don't
uppercase body copy.

---

## 4. Space, shape, elevation, motion

**Radii** (`--r-*`): `xs 6px · sm 8px · md 12px · lg 16px · xl 20px · card 24px`. The browser card is
`--r-card`; inputs/bank card `--r-md`; popovers & wallet/detail cards `--r-lg`; config panel `--r-xl`;
engine chrome `--r-sm`; chips `--r-xs`. A few legacy in-between radii (11/13/14px) remain in
`main.css` — snap toward these steps when you touch them.

**Shadows** (`--shadow-*`): warm-tinted `--shadow-card` (the browser card), `--shadow-tile`
(back-office cards), `--shadow-pop` (portals); plus `--shadow-sm/-md/-lg` for the base layer/cof.
CTAs add an accent glow: `0 10px 26px -8px color-mix(in srgb, var(--accent) 55%, transparent)`.

**Spacing:** no scale token — a soft 4px rhythm (gaps 6/8/9/12/14px, card padding 13–18px). Match the
neighbours; don't introduce new gaps.

**Motion:** fast + physical. Micro-transitions **0.12–0.15s** on `border/background/transform/filter`;
press `transform` ~0.05s. Entrance stagger `.rise-1…6` (fade+rise) on success/error screens. Signature
pops: `cs-pop` (badge overshoot `cubic-bezier(.34,1.56,.64,1)`), `toastIn`. Spinners `.spin`. Reserve
motion for state change, never decoration; no long/linear eases.

---

## 5. Components (reuse before inventing)

Class prefixes map to areas (§9). Specs below are the *shipped* values.

### 5.1 Buttons & triggers
- **Primary CTA `.co-cta`** [A] — full-width, 52–56px, `--r-md`+2, accent gradient, `--on-accent`,
  Hanken 700, accent glow, press-scale. **One dominant action per surface.**
- **Text/link button** [both] — `.use-test`, `.cof-link` — no border/bg, accent colour, 12–13px 600
  (`.cof-link.subtle` for the quietest).
- **Segmented control** [both] — bordered row; `.active` gets `--accent-soft`. Variants `.co-fx-seg`,
  `.tkc-seg`, `.se-seg`, `.cof-dp`, `.prod-select`. Disabled = `opacity:.45` + `title` explaining why.
- **Tab pill / toggle** — `.model-btn` (`--chrome-active` when active), `.env-switch button`
  (accent fill), `.profile-switch button` (accent-soft).

### 5.2 Inputs & editable fields [A]
- **`.co-input`** — 52px, 1.5px `--c-line-3` border, `--r-md`, optional leading `.field-ico`; inner
  `input` is mono 15px. Focus = accent border + 3px `color-mix(in srgb, var(--accent) 14%, transparent)`.
- **`.co-field label`** — 13px 600 `--c-ink-3`.
- **Inline editable tile `.tile-field` / `.tile-amount`** — looks like text until hover (border/bg
  fade in); `field-sizing:content`, right-aligned. The "the whole tile is editable" Layer-C pattern.

### 5.3 Pills, badges, chips, dots [both]
- **`.wh-pill`** [B] — mono 10.5px 700, `--r-xs`, semantic tint ~16% alpha: `.success` / `.failure` /
  `.pending` / `.field` (neutral) / `.evt`. The universal "one fact per pill" unit. (Back-office
  `.backoffice .wh-pill` restates these on light ground.)
- **`.status-ind`** [B] — the header state chip (dot + UPPERCASE label); `kind` = idle/drafting/
  processing/ok/action/error — the demo's heartbeat, driven at every transition via `setStatus()`.
- **Saved-card chip `.cof-chip`** [A] — brand · masked number (mono) · exp · `.cof-chip-kind` tag ·
  optional `NRI ✓`. Radio-select via `.active` (accent ring).
- **Category dot `.vp-dot` / `.eyebrow-dot`** — 8px accent/status dot before a label.
- **Small tag** — `.bo-fx-badge`, `.bo-mit-badge`, `.mb-tag` — mono micro-caps for tile metadata.

### 5.4 Cards & tiles
- **Order tile `.co-order`** [A] — thumb (`.co-thumb`, product glyph on accent gradient) + name/desc +
  price + the FX corner trigger. The storefront's product anchor.
- **Payment tile `.bo-tile`** [A] — ref + brand·last4 (+ FX/MIT/AFT badges) + amounts + status chip +
  chevron; `.clickable` vs `.inert`; hover lifts (`--shadow-tile`).
- **Anchor/summary card** — `.bo-wallet-card`, `.bo-detail-card`, `.bo-cof-card` — 1px `--c-line`,
  `--r-lg`, `--c-card`, warm shadow.
- **Choice card `.bo-route`** [A] — `.active` = accent border + tint; holds a title + note + legs.
- **Totals block `.co-totals` / `.co-line` / `.co-line.total`** [A] — subtotal/fee rows then a heavier
  ruled Total (`--c-ink`, 800). `.per-mo` appends "/mo" for subscriptions.

### 5.5 Engine-room chrome [B]
- **`.panel-eyebrow`** — the uppercase section header with a colour dot (`.eyebrow-dark` on the right).
- **Request block** — `.req-headline` (method pill + path), `.req-headers` grid, `.eng-label`,
  `.hk`/`.hv`. **Method pills** `.method-pill.get/.post/.put/.delete` (colours mirror docs.rapyd.net).
- **JSON view** — `.jsonv` + `--syn-*`; highlighted paths use `--sync-hl`/`--sync-edge`.
- **Console** — `.cl-line` (time · `.cl-tag` · message), `.cl-cursor` blinking caret.
- **Webhook card `.wh-card`** — `<details>` with a pill head + JSON body; `kind` tints the left edge.

### 5.6 Screens (post-payment) [A]
- **`.screen`** — centred column; `.screen-title` (37/800), `.screen-sub`, `.screen-next`, `.rise-*`.
- **Result badge `.cs-badge`** — 78px circle, `cs-pop` overshoot, `.ok` (`--ok-ui`→`--ok-deep`
  gradient) / `.err` (`--err`→`--err-deep`) with ring + drawn check.
- **Facts `.screen-facts`** — click-to-copy `code` rows; null values auto-drop. `.danger` for declines.
- **Bank view `.bank-view`** [A, offstage] — the customer's bank-app statement mock.

### 5.7 Overlays
- **Portals** — `.fx-popover`, `.cur-dropdown` are body-level (escape `.browser`'s overflow) and
  restate Layer A styling explicitly (they can't inherit past `.browser`). Outside-click closes via
  `composedPath()`.
- **Toast `.toast`** — bottom-centre, dark pill (`--ink`), `toastIn`; `.toast-err` = `--err`.
- **SE deck `.se-deck`** [A, offstage] — dashed panel for controls that sit *outside* the fake client site.

---

## 6. Voice: the customer / SE split (a hard rule)

Two audiences share the screen. Never blur them.
- **Customer-facing** (inside `.browser`, the storefront screens): plain human copy, **no API jargon**
  — "Save card for future purchases", "Buy BTC now". No field names, no `snake_case`.
- **SE-facing** (the engine room, the `.se-deck`, toolkit config `.tkc-*`): label every control with
  its **real API key** in mono `code` — `save_payment_method`, `initiation_type`, `require_card_cvv`.

If a control affects the request, the SE side names the exact field it writes; the customer side
describes the *outcome*. This split is the product's core credibility — protect it.

---

## 7. Iconography & product language

- **Product glyphs** — one emoji per product (`🪑 ☕ ₿ 🔁 ⭐ 🎲 ✨`) on the accent gradient in
  `.co-thumb`. Kept in `js/verticals.js`.
- **Inline SVGs** — small, `stroke-width` ~2–2.6, `currentColor` or a muted token; match the
  surrounding text colour.
- **Merchant identity** — each vertical is a PayBridge sub-brand (`PayBridge Shop/Coin/Play`) with its
  own domain in the fake URL bar. Brand stays "PayBridge"; only skin/copy change.

---

## 8. Interaction laws (locked — don't re-litigate)

1. **Left-tab persistence** — Client Site ⇄ Back Office never resets the client flow; only visibility
   toggles. A mid-3DS challenge resumes exactly.
2. **Right-panel choreography** — an action jumps the engine room to the relevant tab: prepared body →
   **Request**, fire → **Response**, event → **Webhooks**, toolkit lifecycle → **Console**. Never
   steal the tab while the SE narrates.
3. **ISO codes only** — `149.00 GBP`, never `£149`. No currency symbols. FX varying side is prefixed
   `≈`; a not-yet-known amount shows `CUR …`.
4. **Live, honest request bodies** — the Request tab updates as you type with a real recomputing
   signature. Never fake a field; omit what the API would omit.
5. **Webhook is the source of truth** — terminal screens are driven by real webhooks; optimistic
   states are labelled ("Waiting for the confirmation webhook…"). No optimistic success screens.
6. **Redaction** — access keys show `rak_ABC***XYZ`; secrets never appear client-side.
7. **Surface guards** — a paint fn checks it's the active surface before writing shared DOM
   (`state.leftView`); a monotonic `actionSeq`/`fxSeq` stops a slow response clobbering a newer one.
8. **Don't clobber a form mid-edit** — background ticks repaint everything *except* an open form.
9. **Field↔JSON sync** — focusing a client field highlights its request path(s) full-row
   (`.sync-hit`). Every new editable SE control MUST register its path(s) in `js/sync.js FIELD_MAP`.

---

## 9. Naming conventions

Class prefixes are the map — new classes go under the right prefix, beside their siblings.

| prefix | area |
|---|---|
| `co-` | checkout / storefront order + fields |
| `prod-` / `cof-` | product selector · card-on-file surfaces |
| `se-` | sales-engineer strategy deck (offstage) |
| `fx-` / `cur-` | FX popover + currency dropdown portals |
| `tk-` / `tkc-` | toolkit page + toolkit config panel |
| `bo-` | back office (tiles, wallet, detail, routes, refund, `bo-cof-`/`bo-charge-`) |
| `wh-` | webhook cards + pills |
| `req-` / `eng-` / `jsonv` / `cl-` | engine-room request, labels, JSON view, console |
| `screen-` / `cs-` / `bank-` | post-payment screens, result badge, bank-app mock |
| `prof-` / `profile-` | sandbox key-profile switch |
| `chrome`-adjacent: `topbar` / `subbar` / `vertical-pills` / `model-` / `env-switch` | the app shell |

IDs mirror prefixes (`#fx-popover`, `#bo-cof-sync`, `#prod-select`). Stable delegation roots
(`#checkout`, `#backoffice`, `#fx-popover`) keep their identity across re-renders — only innerHTML is
rebuilt.

---

## 10. Adding a vertical

A token block in `tokens.css` (4 accent tokens + 7 engine tints — engine hue follows the accent, value
stays near-black) + an entry in `js/verticals.js` (label, dot, merchant, descriptor, domain, headline,
cta, successNote, product). Accent must pass 4.5:1 on white for text use, or use `--accent-soft` fills
with accent text. **Only context, copy and colour change — layout never forks per vertical.**

---

## 11. Reconciliation history (2026-07-25)

This file and `css/tokens.css` were consolidated from four competing vocabularies that had accreted in
the repo:
- the shipped `tokens.css` + `main.css` "design-refresh layer" (which hardcoded the entire client
  palette as literals),
- an audit `tokens.v2.css` / three-layer `DESIGN.md` (the consolidation target),
- an orphaned blue/Inter alternate app (`style.css`), and a stray Segoe-UI status page
  (`styles/style_payments.css`).

The refactor: adopted the consolidated token set as the **single `tokens.css`**; pointed `main.css` /
`cof.css` at those tokens (value-preserving, with a short list of near-duplicate greys/status colours
snapped to the nearest step); deleted the two orphan stylesheets and two unused root scripts
(`checkout.js`, `retrieve-payment.js`); and merged the two design docs into this one, kept in-repo
beside the CSS it governs. **When a redesign touches a primitive, change `tokens.css` and update the
relevant section here so this file stays the source of truth.**

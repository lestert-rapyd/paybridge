/* ─────────────────────────────────────────────────────────────
   client_details — browser context that optimises 3DS decisioning,
   harvested live (real values, not stubs). Included on every
   customer-present payment; NEVER on back-office MIT charges (the
   customer isn't present). ip_address is injected server-side by
   the payment proxy — the browser can't see its own public IP.
   ───────────────────────────────────────────────────────────── */

export function clientDetails() {
  return {
    // EMV 3DS convention: minutes between UTC and local (UTC-5 → 300),
    // exactly what Date#getTimezoneOffset returns.
    time_zone_offset: new Date().getTimezoneOffset(),
    language: navigator.language || 'en-US',
    java_enabled: false, // navigator.javaEnabled() is dead — always false in modern browsers
    java_script_enabled: true,
    screen_color_depth: screen.colorDepth || 24,
    screen_height: screen.height,
    screen_width: screen.width,
    accept_header: 'text/html',
  };
}

# Firefox MV3 parity and extension API gaps

Type: research
Status: resolved
Blocked by: none

## Question

The frozen product ships a Chromium-only MV3 extension with no `browser_specific_settings`. Firefox is a first-release target, so establish the delta before the extension architecture is decided.

Required facts:

- Firefox MV3 background model today: event pages versus service workers, termination behaviour, and persistent-background availability.
- API gaps and behavioural differences that matter here: `chrome.storage`, alarms, native messaging, offscreen documents, `declarativeNetRequest`, and content-script injection timing.
- WebAuthn and passkey mediation availability to a Firefox extension, including conditional mediation.
- Native messaging on Firefox: manifest location per OS, allowed-extensions binding, and how it differs from Chromium's `allowed_origins`.
- Firefox add-on signing and review constraints for an extension shipping WASM.
- Whether one MV3 codebase can realistically serve both, and what the standard build-time split looks like.

Write findings to `planning/greenfield-decision-map/research/firefox-mv3.md`. Facts only, with source URLs and retrieval dates.

## Answer

Findings: [`research/firefox-mv3.md`](../research/firefox-mv3.md), 608 lines, every claim carrying a
fetched URL and a 2026-08-20 retrieval date.

The delta is real but tractable, and it lands hardest on how secrets reach a content script.

- **Firefox has no extension service worker.** `background.service_worker` is `false` in MDN
  browser-compat-data, and Bugzilla 1573659 is still `NEW` as of 2026-08-12. Firefox MV3 is an event
  page: a real document with `window` and DOM.
- **Both engines suspend the background after 30 s idle,** and both exempt an open native-messaging
  port from termination. Firefox's `extensions.background.idle.timeout` defaults to 30000 ms, and the
  in-tree comment says it copied Chrome deliberately. The desktop-app port is the one keep-alive that
  behaves identically on both.
- **`storage.session.setAccessLevel` is unsupported on Firefox,** so content scripts can never read
  session storage there. Autofill must receive secrets by message on Firefox, with no exception.
- **Content scripts inject into already-open tabs on Firefox and not on Chromium,** and Firefox keeps
  no per-world `on*` handlers, so `element.onclick = ...` from a content script clobbers the page and
  rival password managers. `addEventListener` only.
- **No engine has a passkey-provider API.** WECG issue 361 is open (`opposed: safari`, `neutral:
  chrome`, no Firefox position); issue 984 was closed as duplicate in April 2026. Passkey mediation
  stays a MAIN-world `navigator.credentials` override, needing Firefox 128+, and `prf` needs 139+.
- **One manifest can serve both:** declare `scripts` and `service_worker` together, a pattern MDN
  documents, needing Firefox 121+ and Chrome 121+. The `browser` namespace stopped being a split
  point at Chrome 148.
- **Firefox-only obligations:** a self-chosen `browser_specific_settings.gecko.id` is mandatory for
  MV3 signing; a second native-messaging manifest using `allowed_extensions` at Mozilla-specific OS
  paths; `data_collection_permissions` for new AMO submissions since 2025-11-03; and AMO policy 3.1
  reproducible-source review, which the WASM core will have to satisfy.

Marked unverified in the report: any Firefox alarm-period clamp, whether an extension can populate
Firefox's conditional-mediation UI, WASM-specific AMO rules, AMO review turnaround, and any named
build-split tooling recipe.

This ticket surfaced facts and decided nothing. Ticket 41 owns the extension architecture decision.

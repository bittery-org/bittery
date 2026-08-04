# E2E harness context

Design context for `apps/web/tests` that is too long to live in a code comment.
The fixtures reference this file; keep the two in sync.

## `gotoRoute` retries the navigation

The router code-splits every route, so a navigation fetches that route's chunk
from the Vite dev server — and late in a long serial run that dev server
occasionally never answers. The document still loads, so nothing throws: the
router simply sits on an empty outlet until the test times out, which reads
exactly like a product bug. Reloading re-issues those requests.

The retries are bounded and the last attempt asserts unconditionally, so a route
that genuinely never renders still fails — and says where the page ended up,
which is what tells a stalled chunk apart from an unexpected redirect. Each
retry pushes a `route-retry` annotation, so the count in the JSON report
measures how much the dev server is struggling; without it a passing run cannot
be told apart from one that passed only because the helper absorbed a
20-second stall.

`E2E_STRICT_ROUTES=1` drops the retries and asserts on the first attempt, which
is how the papering-over gets switched off to see the raw truth.

## `restoreSession` is never a substitute for a sign-in test

`restoreSession` replays the browser profile a real sign-in would have produced,
so it is only ever a *shortcut past* the sign-in. Nine real sign-ins stay in the
suite on purpose, one per branch of that flow: fresh-device full sign-in with
the Secret Key hint, quick unlock, wrong password, sign-out clearing the device,
the expired-session banner, `?redirect=`, the three credential-change re-logins
in settings, and the post-recovery sign-in. Optimising any of those into a
restore would leave the code path the fixture bypasses with no coverage at all.

Sync state is deliberately outside a snapshot: two contexts sharing a
`bittery_sync_client_id` would be one device, and self-echo suppression would
stop being exercised. `sync.spec.ts` pins that the two ids differ.

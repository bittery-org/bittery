# Browser durability prototype observations

Observed: 2026-08-21.

These are narrow prototype observations, not cross-browser guarantees. The interpretation limits in
[`README.md`](README.md) apply.

## Environment

- Browser: T3 Code Nightly 0.0.34, Chromium 146.0.7680.216 on macOS user-agent platform.
- Served through the collaborative preview's private-address HTTP proxy.
- `window.isSecureContext`: `false`.
- IndexedDB and dedicated Workers: available.
- OPFS and persistence quota reporting: unavailable because the preview rewrote `localhost` to an
  insecure private-address origin. This is not the secure-context deployment fixed by `HOST-007`.
- The page loaded and the same-origin Worker executed under the prototype's target CSP, including
  `worker-src 'self'` and no `unsafe-inline` or `blob:` source.

## Observations

1. The known state at commit sequence 70 reopened with no local operation, immutable object, or
   overlay effect.
2. Five independent forced terminations after the Worker had issued the logical commit's writes but
   before IndexedDB transaction completion all reopened the whole old commit 70. No partial logical
   commit was observed.
3. Forced termination after IndexedDB reported transaction completion but before the prototype
   acknowledged success reopened the whole new commit 71. The operation, immutable object, and
   overlay effect were all present. This is an indeterminate caller outcome, resolved by reopening the
   Replica rather than by treating the operation as absent.
4. An acknowledged commit reopened as the whole new commit 71.
5. Deleting the origin's IndexedDB after that acknowledged but unsynchronized commit removed the
   complete Replica and operation. Browser transaction completion therefore does not protect
   unsynchronized work from origin removal.
6. The OPFS experiment failed closed as unavailable in this environment. It did not produce evidence
   for or against OPFS on the secure product origin.

## What the result decides and does not decide

The run is evidence that this Chromium build preserves the Account-atomic old-or-new invariant when
its Worker is terminated. It also makes the post-commit/pre-ack indeterminate case concrete and shows
that whole-origin loss dominates transaction atomicity.

It does not establish physical disk persistence, power-loss behavior, eviction resistance, Safari or
Firefox behavior, extension-runtime behavior, or a stronger guarantee from OPFS. Those facts remain
bounded by the primary-source report in
[`browser-storage-durability.md`](../../research/browser-storage-durability.md).

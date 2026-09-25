# Extension page features and production caller boundary

Type: research
Status: resolved
Blocked by: 60, 64, 79
Spec: ../desktop-extension/extension-cutover.md

## Question

What exact closed Core page-feature, navigation-handoff and activity scopes preserve the current
Extension callers under the reviewed74/75/79/97 boundaries, so76 can replace every production owner
without inventing authority, dropping a gesture or retaining a plaintext storage fallback?

## Source evidence and accepted answer

The [focused draft](../desktop-extension/extension-cutover.md) inventories all47 routes in
`apps/extension/src/background/router/contract.ts` plus popup-to-content `FILL_ITEM`, and the actual
manifest/background/popup/content/main-world/six-iframe import graph.74 owns placement and caller
authentication;75 owns private passkey ceremonies;79 removes Desktop snapshot authority;97 preserves
the old consumer only until76. The missing boundary is the full product caller mapping, not another
application/Worker/Session owner.

Current autofill returns whole decrypted Items to content/iframes and popup Fill forwards a retained
Item to the then-active tab. Use scoped public candidates, opaque choices and a final guarded
category-specific fill result from the same Core. Preserve field detection/ranking/presentation and
reuse66's closed Item TOTP request plus95's private-preserving Item update for QR/capture edits.

Capture is scoped to the active unlocked Account: AccountVaultRuntime hydrates every unlocked
Account but sets only the active one as readable; Desktop snapshot and writable-Vault callers use
that same active Account. Do not confuse hydration/resolver fallbacks with an all-Account chooser.
The old pending save record is one global Chrome plaintext value without tab, Account or expiry.
Replace it with an unaccepted Core intent and one authenticated same-tab successor document at a
time through login redirects. Use the existing30-second duration as one Core-clock budget from BeginCapture admission, covering
preparation, pre-presentation redirects and display; retain dismissal and two-second success
presentation, and no replay extends the lifetime. Broker recycle keeps
the surviving owner; actual owner loss/Lock retires the intent. Save/Update acceptance uses existing
Core Operations and does not depend on the continued popup/document lifetime.

The five-minute `needsReauth` path opens the popup; authenticated/unlocked CHECK_AUTH or Vault reads
refresh the activity timestamp. It does not require a password. Preserve this confirmation using
the same Core-clock activity owner and authenticated popup gesture. Check eligibility before a
content candidate request can refresh its own grace; the existing handler's precheck activity stamp
must not remain a route around the existing confirmation policy.

An earlier inventory described a global persistent timeout. Actual AccountStore source disproves
that: omitted `accountId` resolves the active Account, and `auto_lock_timeout` is Account scoped.
Fresh Accounts inherit the existing ten-minute default. Preserve the single settings UI and write
its captured actual Account; reuse67's ONE Device activity record, selected-Account preference and
Device-wide inactivity effect. Delivery76 must connect Core's existing native-state owner to the inactivity algorithm and popup
Lock admission;67/68 do not yet implement this integration. Preserve the actual distinct Desktop-
owned automatic suppression and connected-Desktop popup refusal, without a TS timer or an Account-
grant-only timer policy. Sign-out retains its separate admitted lifecycle. No new persistent Device preference or password ceremony is needed.

## Review and delivery boundary

Independently review the concrete generated controls, original-deadline handoff, candidate fields,
native-aware activity selector and complete route/removal acceptance before resolving98 or marking76
ready. Reuse existing receipt ordering, foreground guards, native ownership and driver algorithms;
there is no accepted new policy cache, scheduler, private credential mirror or public crypto invoke.
The draft records actual-browser tests rather than claiming capability or production acceptance.

## Comments

2026-09-09: coordinating review authorized bounded research98 and the focused76 draft. The active
Account capture selector, ephemeral same-tab capture intent, original deadline, no-password popup
confirmation and existing67/native activity-owner reuse are accepted routine directions. Research
remains claimed and76 needs-triage for independent concrete review. No implementation, heavy build,
capability completion, dependency completion or production activation is claimed.


2026-09-09 coordinating timing refinement: generic Chrome messaging and router startup/dispatch have
no bounded total capture preparation timeout. Reuse30 seconds from Core BeginCapture admission for
preparation, same-tab redirects and display, explicitly changing the old post-display timer start.
No presentation acknowledgement can delay/reset the deadline; pre-presentation navigation remains
supported. Expiry retires unaccepted plaintext/preparation, never already accepted Operations.
Source review also distinguishes future76 native/inactivity integration from completed67/68:
existing popup LOCK is refused when Desktop is connected, automatic countdown is suppressed for
Desktop-owned access, and LOGOUT is not subject to popup refusal. One Core native-state owner and
existing inactivity algorithm must implement those selectors; no new host policy owner is allowed.

2026-09-09 final independent review passed after preserving the explicit74 exception for an already
registered same-owner capture handoff and identifying native tests as future76 acceptance. The
closed control, candidate/private fields, trusted active-Account pointer, original30-second budget
and distinct native activity/Lock predicates are sealed. All39 reviewed local links/anchors and
scoped whitespace checks pass. Research98 is resolved;76 is ready with incomplete dependencies,
so no Extension implementation or production acceptance is claimed.

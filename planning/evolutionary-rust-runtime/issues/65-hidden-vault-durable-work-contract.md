# Hidden Vault local erasure and accepted work

Type: grilling
Status: resolved
Blocked by: 60

## Question

Which local records survive Travel mode when accepted Operations have not yet received an
authoritative outcome?

## Accepted contract

Erase hidden Vault keys, cached authority in all generations, decrypted projections and unneeded
file capabilities/artifacts. Preserve only immutable encrypted accepted Operation evidence and
indispensable encrypted artifacts until Core can reconcile their authoritative outcomes, as required
by tickets 09/10/12. They are unavailable for reads, decryption, new work or resumed transcryption.
No pending work may silently disappear merely because a policy event arrives or a host restarts.

This requires dedicated Core tests and actual multi-client Travel mode acceptance. A list filtered
by the active Vault set alone cannot establish local-erasure acceptance. Native Session retention
and in-progress file capabilities must be included in the contract.

## Comments

2026-09-08: maintainer accepted retaining inaccessible encrypted accepted-work evidence. This is
the sole minimal durable-work exception; it does not authorize retaining hidden Vault keys or
unneeded authority/file copies. The implementation and real multi-client acceptance remain open.

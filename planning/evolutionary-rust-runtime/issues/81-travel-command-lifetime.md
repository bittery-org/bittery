# Travel configuration command lifetime

Type: grilling
Status: resolved
Blocked by: 60, 65

## Question

Should Travel configuration preserve its existing foreground lifetime under Core ownership, with
an ambiguous disable response reconciled against current Server policy and fresh password entry
required if another disable attempt is needed? Or should disabling become a durable Operation with
a new scoped Server authorization/outcome contract?

## Evidence and recommendation

The existing disable proof is one-use and creates no Session. Persisting that proof or another login
secret for automatic retries would not preserve the current authentication contract. Foreground
configuration with explicit authoritative reconciliation preserves existing product behavior while
Core owns the request, proof, response interpretation and local erasure. It creates no durable
acceptance promise for a configuration command. Already accepted Item/Vault Operations remain durable
under decision 65; this question does not reopen their hidden-data retention contract.

A durable alternative needs its own one-action authorization and retained outcome specification.
It cannot silently repeat SRP after password/owner loss or turn Quick Unlock into Travel disable.

## Comments

2026-09-09: precise question sent to the maintainer while independent Desktop capability work
continues. No answer or implementation authorization for either unresolved alternative is inferred
from elapsed time. Ticket 71 remains unready until this frontier and its acceptance mapping close.

## Accepted decision

2026-09-09: the maintainer selected foreground settings with explicit reconciliation and fresh
password retry. Core owns configuration, password-proof creation, response interpretation and
authoritative policy reconciliation. An ambiguous disable response must be checked against current
Server policy; if another disable attempt is needed, require fresh password entry and a fresh proof.
Adding a durable disable Operation, persisting the one-use proof or another login secret, silently
repeating SRP, or substituting Quick Unlock/biometric release is not authorized by this decision.

If current policy cannot be obtained, report uncertainty and preserve the existing verified policy
and erasure obligations. Do not claim disable succeeded or release hidden authority from an ambiguous
response. The existing foreground command creates no durable acceptance promise. Already accepted
encrypted work retains decision65's separate durable ownership. No Server retained-outcome or new
authorization contract is introduced for Travel configuration.

The command-lifetime frontier is resolved. Ticket71 still requires its detailed command/projection
and acceptance specification plus completion of its implementation dependencies before it starts.

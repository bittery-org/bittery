# External integrations, favicons, and the opt-in rule

Type: grilling
Status: ready-for-human
Blocked by: 04, 26

## Question

`HOST-006` says no client or Server contacts an external service by default. The frozen product violates the spirit of this in the single largest way available: the server fetches favicons from the open internet keyed by item domain, keeps a Postgres table of every domain its users hold items for, refreshes it weekly, and exposes an unauthenticated `GET /favicon/{domain}`. There is also a `/cdn/{*key}` proxy of presigned S3 URLs. Neither appears in the current-state catalog. See [current-state verification](../research/current-state-verification.md).

Decide:

- Whether Bittery shows item icons at all, and if so how without building a domain database.
- The complete integration list, each with what it discloses and to whom, and the opt-in mechanism.
- Whether any integration may be server-side, or whether all outbound requests are the client's choice.
- What the `/cdn` proxy is replaced by, if anything.
- Breach detection, if [Sentinel](34-sentinel-and-password-generation.md) puts it in scope.

Produces: `HOST-006` enforcement requirements and a CI rule that external calls are off by default.
## Comments

### Inherited from ticket 05, client delivery trust and transport

`HOST-009` pins `img-src 'self' data:`, so the Web client cannot fetch a favicon from a remote origin
at all: the policy blocks it before any opt-in setting is consulted. Either the Server proxies
favicons, which makes the Server the party contacting the external service under `HOST-006`, or the
Web client shows no remote favicons and only installed clients do. Decide which, and keep the policy
string in `HOST-009` correct either way.

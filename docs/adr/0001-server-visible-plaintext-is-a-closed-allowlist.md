# Server-visible plaintext is a closed allowlist

Status: accepted

Bittery claimed zero knowledge against its administrator before anything defined what the Server was
allowed to learn, so two implementers could draw the ciphertext boundary in different places and
neither build could be shown to violate a requirement. `PRIVACY-007` now enumerates the exact
plaintext field set, and `PRIVACY-006` makes it closed: any plaintext column the list does not name
is a defect, and a repository check fails on one. The headline claim becomes something a test can
break.

## Considered options

An advisory list, describing what happens to be visible, was rejected because it drifts silently. The
first engineer who adds a plaintext column for a good reason ends the guarantee, and nothing notices.

Metadata minimization, hiding the Vault membership graph and padding ciphertext, was rejected for the
first release. Bittery promises content confidentiality, not traffic analysis resistance, and
promising less honestly is worth more than promising more vaguely.

## Consequences

Vault names, Team names, Device names, email addresses, and the full Vault membership graph are
readable by the operator, by deliberate choice. Administrators need them to run a deployment, and
`PRIVACY-013` requires the documentation to say so in plain language rather than let "zero knowledge"
imply otherwise. Vault names are the field users most assume is protected, so the disclosure leads
with it.

Ciphertext is not padded (`PRIVACY-009`), so ciphertext length is visible and correlates loosely with
Item type.

Server-side access control is demoted. A grant means a member wrapped the Vault key for someone
(`PRIVACY-003`), so the Server's authorization records protect availability and bound abuse, and
never protect secrecy. Tickets 22 and 29 inherit that constraint.

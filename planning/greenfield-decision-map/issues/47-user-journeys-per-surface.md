# User journeys per surface

Type: grilling
Status: ready-for-human
Blocked by: 31, 44

## Question

The settled platform split, which this ticket turns into journeys:

- **Web** owns signup, recovery, teams, invitations, audit and admin, plus the full vault.
- **Desktop** is the full vault client plus Sentinel, Share links, and import/export.
- **Extension** is autofill, reading Items, TOTP, and passkeys: whatever the user needs in the browser. No import/export, no Sentinel.

Decide:

- The journey inventory per surface, each with its entry point, happy path, and failure paths.
- What a user does when they land on a surface that does not own the thing they want.
- First-run: from empty deployment to first Item, per surface.
- Lock, unlock, and re-authentication as journeys rather than states.
- Error and recovery journeys, especially for the honest limitations the security decisions produce.

Produces: the journey inventory that acceptance scenarios and UI specifications are written against.

### Inherited from ticket 09, recovery model and single-artifact paths

Three journeys are now fixed in outline and need their per-surface detail here. `AUTH-023` blocks the
end of Account creation until the Emergency Kit is printed or saved. `AUTH-026` runs recovery as a
single flow that shows no Vault content until a new master password, a Secret Key rotation, a new
Recovery Key, both sheets, and the sign-out of every other Device are done. `AUTH-029` is one screen
listing every live unlock route with each one revocable from it.

`AUTH-028` sets the words: revocation and rotation are **forward protection**, not erasure, and the
interface must not let a User read a deletion as an erasure.

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

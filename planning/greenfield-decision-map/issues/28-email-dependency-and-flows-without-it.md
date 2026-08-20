# Email: what needs it, and what must work without it

Type: grilling
Status: ready-for-human
Blocked by: 26

## Question

`HOST-005` says email is optional and essential flows cannot depend exclusively on SMTP. The frozen product has **no email at all**: `auth/email.rs` is a dev stub that the config layer refuses in production, so signup verification, account recovery, and email-restricted Share access all fail closed today. Team invitations were never emailed. This is new construction, not a replacement. See [current-state verification](../research/current-state-verification.md).

Decide:

- Whether the product ships an email integration in the first release at all.
- The no-email path for each flow that conventionally uses it: signup verification, invitation, recovery, share notification.
- Whether email addresses are even required as identifiers, given they are the reason several of these flows exist.
- What `SHARE-002`'s email allowlist means when no SMTP exists.
- Whether email is ever load-bearing for security, or only for convenience.

Produces: `HOST-005` refinement and flow specifications that hold with SMTP absent.

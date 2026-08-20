# Device enrollment protocol

Type: grilling
Status: ready-for-human
Blocked by: 08, 09

## Question

`AUTH-004` names three enrollment paths (trusted-device QR, master password plus Secret Key, Emergency Kit) and says the Server alone cannot provision decryption keys. The protocol behind the QR path does not exist yet.

Decide:

- The trusted-device enrollment protocol end to end: channel, authentication of both ends, what the QR payload carries, replay and relay resistance, and expiry.
- Whether the existing device must approve explicitly, and what it displays so a user can detect a relay attack.
- What the Server sees during enrollment, checked against the closed plaintext list.
- Device identity: how a Device is named, keyed, and listed, and whether it holds a device keypair.
- Enrollment when the user has exactly one device and it is lost.
- Rate limiting and abuse on the enrollment endpoints.

Produces: an enrollment protocol specification, `AUTH-004` refinement, and seed scenarios.

## Comments

### Inherited from ticket 04, threat model and server-visible plaintext

`PRIVACY-004` makes silent Device enrollment Detectable, not merely audited. Every existing Device of
an Account must be told when a Device is enrolled, and the notification cannot depend on the Server
choosing to deliver it. `PRIVACY-007` puts the Device name in Server-visible plaintext, so enrollment
carries a user-chosen label the operator reads.

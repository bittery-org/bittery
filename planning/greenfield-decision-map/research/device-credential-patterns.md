# Device credential patterns in established password managers

Research date: 2026-08-21

## Scope and evidence

This report asks how an already-enrolled client authenticates ordinary Server traffic. It separates
that question from local Vault unlock and from the one-time proof used to add a client. It covers
1Password and Bitwarden. No third implementation is included: these two already provide the two
directly relevant, strongly evidenced patterns (a key-bound session and bearer tokens), and no third
first-party protocol source was needed to distinguish them.

Evidence is limited to first-party security documentation, support documentation, and source code.
Bitwarden source links are pinned to client commit
[`2992d176`](https://github.com/bitwarden/clients/tree/2992d17688c0ad43afc434da09f9aae9a9f6d996)
and Server commit
[`ac309aa`](https://github.com/bitwarden/server/tree/ac309aa19ed351406a56032d5f26a7a9a99f4abd),
both inspected on the research date. 1Password's clients and Server are not public, so claims beyond
its published security design are marked unknown rather than inferred from behavior.

## Short answer

| Product | Persistent client material relevant to Server authentication | Ordinary traffic | Device-specific revocation | Main stolen-credential consequence |
| --- | --- | --- | --- | --- |
| 1Password, password + Secret Key accounts | Secret Key plus locally cached encrypted key material; the account password is supplied on unlock | Each sign-in runs SRP and derives a unique session key. Every request proves knowledge of that key. This is a key-bound session, not a documented bearer token. | A named client can be deauthorized. Exact session invalidation timing and wire mechanics are not public. | A stolen Secret Key alone is insufficient. Secret Key plus password enables a fresh SRP sign-in and Account-key decryption. A stolen live session key should authorize only that session, but its lifetime is not published. |
| 1Password, passkey/SSO accounts | A unique random Device key; the Server stores a Device-key-encrypted credential bundle containing the AUK and an SRP client secret | After external authorization releases the encrypted bundle, the client decrypts it and uses SRP like the password path | A linked app or browser can be unlinked. On the next sign-in attempt the client is told and deletes its Device key. | Device key alone does not release the bundle through the documented honest-Server flow. Device key plus usable SSO authorization or the limited reauthentication token can recover the bundle and then Account keys. |
| Bitwarden | A client-generated application UUID plus bearer access and refresh tokens. Optional trusted-device SSO also stores a local symmetric Device key, but that key is for Vault-key release, not request authentication. | A one-hour JWT access token is sent as `Authorization: Bearer`. A reusable refresh token renews it. There is no per-request Device signature or proof of possession. | The normal user control rotates an Account-wide security stamp and logs out every session. Source has a per-Device deactivate endpoint, but it only marks the Device inactive and deletes trusted-device key blobs; it does not rotate the Account security stamp. | An access-token thief can act as the User against protected API routes until expiry. A refresh-token thief can keep obtaining access tokens while the reusable sliding token remains valid. Neither token alone decrypts ordinary password-protected Vault ciphertext. |

## 1Password

### Password and Secret Key accounts

#### Documented behavior

The persistent high-entropy authentication input is the Secret Key. It is generated locally at first
signup and stored by each enrolled client. 1Password says to assume an attacker with disk read access
can acquire it. The account password and Secret Key derive two independent values: the Account Unlock
Key (AUK), used for encryption, and the SRP client secret, used for authentication. The personal key set
is normally cached encrypted under the AUK, so an existing client may work offline after local unlock.
([1Password Security Design, sections 3.2, 8.2.6, 8.5, and A.10.2](https://1passwordstatic.com/files/security/1password-white-paper.pdf))

A newly enrolled client receives an add-device link, possibly as a QR code, containing the Server
domain, email, and Secret Key. It generates a Device UUID and supplies Device information, then uses
the password and Secret Key to perform SRP. Successful SRP lets it fetch the encrypted personal key
set. There is no separately described long-lived Device authentication key or Account-signed Device
authorization in this path. ([1Password Security Design, sections 8.3-8.4](https://1passwordstatic.com/files/security/1password-white-paper.pdf))

The Server stores the Device UUID and, when available, operating system, user agent, and hostname.
The public paper does not describe a Device public key for password-based clients.
([1Password Security Design, section 8.3](https://1passwordstatic.com/files/security/1password-white-paper.pdf))

Ordinary online traffic uses a key-bound session. SRP jointly creates fresh ephemeral values and a
unique session key. 1Password uses that key as an additional encryption and authentication layer over
TLS, and states that every request must prove knowledge of the session key. A captured SRP transcript
cannot be replayed as a later sign-in because each exchange is different.
([1Password Security Design, sections 4.1.2, 14.2, and Appendix B](https://1passwordstatic.com/files/security/1password-white-paper.pdf))

1Password exposes a per-client control: linked apps and browsers are listed by name, and a User can
unlink or deauthorize one. Its lost-device guidance says deauthorizing the lost Device prevents it from
using the Account, and recommends regenerating the Secret Key as the stronger response. Regeneration
requires the new Secret Key and password again on the remaining Devices.
([1Password linked-device guidance](https://support.1password.com/unrecognized-device/),
[lost-device guidance](https://support.1password.com/lost-device/))

#### Consequences and unknowns

- A stolen Secret Key by itself is neither an authentication credential nor an Account decryption key;
  the password is still required. A thief with both can make a fresh SRP session and derive the AUK.
- A stolen live session key is proof of authentication for that session. The public design does not
  disclose session duration, rekey cadence, nonce/counter framing, or how quickly a Device
  deauthorization kills an already-live session. These remain unknown.
- The published protocol gives replay resistance to the SRP sign-in and cryptographically binds later
  requests to its session key. It does not publish a durable Account-signed Device roster that another
  client can independently verify.
- Revocation cannot erase already-decrypted Vault data or cached ciphertext and keys from a stolen
  endpoint. 1Password's general revocation discussion acknowledges that a recipient cannot be made to
  forget material it already received. ([1Password Security Design, section 10](https://1passwordstatic.com/files/security/1password-white-paper.pdf))

### Passkey and SSO accounts: a different Device-key layer

#### Documented behavior

For passkey or SSO unlock, every linked app or browser generates a unique random Device key that never
leaves that client. The Server stores a separate credential bundle for it, encrypted under that Device
key. The bundle contains a random AUK and SRP client secret. External passkey or SSO authorization is
required before the Server returns the encrypted bundle; after local decryption, normal 1Password SRP
authentication and traffic are the same as the password path.
([1Password Security Design, sections 9.1-9.2](https://1passwordstatic.com/files/security/1password-white-paper.pdf))

The first client is linked during initial setup. An additional client authenticates to the passkey or
identity provider and must be approved by an already-linked client. The old and new clients use a
six-character code with CPace to derive and mutually confirm an end-to-end session key through the
1Password Server. The old client transfers the credential bundle only inside that channel. The new
client then creates its own Device key and uploads its own encrypted copy. The paper states that
malicious-Server interference in this key agreement is detected.
([1Password Security Design, sections 9.2-9.3](https://1passwordstatic.com/files/security/1password-white-paper.pdf))

Biometric quick unlock can retain a separate, limited-time reauthentication token so the Device need
not contact the identity provider on every unlock. On macOS, iOS, and Android it is protected with
platform secure hardware; on Windows and Linux it is held in protected process memory and disappears
when the app exits. The public paper does not state the token's exact lifetime or whether it is bearer or
proof-of-possession.
([1Password Security Design, section 9.4](https://1passwordstatic.com/files/security/1password-white-paper.pdf))

When a linked SSO client next attempts to sign in after deauthorization, it is told it is deauthorized
and deletes its Device key. 1Password also documents delegated sessions from the web or Desktop app
to the browser extension or CLI using a short-term session key.
([1Password SSO security guidance](https://support.1password.com/sso-security/))

#### Surface differences

- The same SRP authentication and key-bound request pattern applies to web and native password-based
  clients. The web client caches less local data than mobile clients and therefore has less offline
  capability. Its code is freshly delivered by the Server, so a maliciously substituted web client can
  steal client secrets despite the protocol. ([1Password Security Design, sections 8.5 and A.1](https://1passwordstatic.com/files/security/1password-white-paper.pdf))
- Desktop apps and 1Password.com can delegate short-lived sessions to the extension or CLI. That is a
  convenience bridge, not a different Server authentication primitive.
- Device-key protection for passkey/SSO differs materially: iOS, macOS, and Android use hardware-backed
  protection; platforms and browsers without it may store the Device key only lightly obfuscated on
  disk. 1Password explicitly says malware that steals both this key and SSO cookies can access the
  Account. ([1Password Security Design, Appendix A.10.3](https://1passwordstatic.com/files/security/1password-white-paper.pdf))

## Bitwarden

### Persistent material and enrollment

#### Documented behavior

Bitwarden's security paper describes password login as sending a Master Password Hash for Server
authentication while keeping the password and derived encryption keys client-side. “Log in with
device” is an alternative one-time authentication flow: the new client creates an ephemeral Auth-request
key pair, an already-logged-in Device encrypts the User Encryption Key to that public key, and an access
code completes authentication. The request keys exist only for that request.
([Bitwarden Security Whitepaper, “Authentication and decryption” and “Log in with device”](https://bitwarden.com/help/bitwarden-security-white-paper/))

#### Source-based findings

Each installation creates and persists a random application GUID. Every login sends this identifier,
Device type, and Device name while requesting scopes `api offline_access`.
([client AppId service](https://github.com/bitwarden/clients/blob/2992d17688c0ad43afc434da09f9aae9a9f6d996/libs/common/src/platform/services/app-id.service.ts),
[identity-token request](https://github.com/bitwarden/clients/blob/2992d17688c0ad43afc434da09f9aae9a9f6d996/libs/common/src/auth/models/request/identity-token/token.request.ts))

On successful authentication, the Server either finds that `(UserId, Identifier)` row or creates one
bound to the authenticated User. For an unknown Device, password login can require an emailed
one-time code when neither two-factor nor SSO already applies. The identifier is therefore a persistent
label and a “known Device” signal, not a secret proof-of-possession credential.
([Server Device validator](https://github.com/bitwarden/server/blob/ac309aa19ed351406a56032d5f26a7a9a99f4abd/src/Identity/IdentityServer/RequestValidators/DeviceValidator.cs))

The Server Device row holds its own database ID, User ID, client-supplied name, type and identifier,
optional push token, creation/revision/last-activity dates, active flag, last client version, and optional
encrypted trusted-device key blobs. The access/refresh token subject also carries the Device identifier
and type as Server-signed claims.
([Device entity](https://github.com/bitwarden/server/blob/ac309aa19ed351406a56032d5f26a7a9a99f4abd/src/Core/Entities/Device.cs),
[token claim construction](https://github.com/bitwarden/server/blob/ac309aa19ed351406a56032d5f26a7a9a99f4abd/src/Identity/IdentityServer/RequestValidators/BaseRequestValidator.cs))

Optional SSO with trusted devices adds a local 512-bit symmetric Device key and an RSA-2048 key pair.
The client uploads the User key encrypted to the Device public key, the public key encrypted under the
User key, and the private key encrypted under the local Device key. This mechanism releases the User
Encryption Key after SSO authentication; it is not used to sign ordinary API requests.
([trusted-device client implementation](https://github.com/bitwarden/clients/blob/2992d17688c0ad43afc434da09f9aae9a9f6d996/libs/common/src/key-management/device-trust/services/device-trust.service.implementation.ts),
[Server decryption-option builder](https://github.com/bitwarden/server/blob/ac309aa19ed351406a56032d5f26a7a9a99f4abd/src/Identity/IdentityServer/UserDecryptionOptionsBuilder.cs))

### Ordinary traffic, lifetime, and replay

#### Source-based findings

The identity response contains an access token, token type, expiry, and optional refresh token. For
ordinary authenticated API calls, the shared client code obtains the current access token, refreshes it
when needed, and sends `Authorization: Bearer <token>`. There is no per-request Device signature,
channel binding, or proof-of-possession in this path.
([identity-token response](https://github.com/bitwarden/clients/blob/2992d17688c0ad43afc434da09f9aae9a9f6d996/libs/common/src/auth/models/response/identity-token.response.ts),
[API request and refresh implementation](https://github.com/bitwarden/clients/blob/2992d17688c0ad43afc434da09f9aae9a9f6d996/libs/common/src/services/api.service.ts))

The default Server configuration gives web, browser extension, Desktop, and mobile access tokens a
one-hour lifetime. Refresh tokens are reusable rather than rotated. By default their expiry slides on
each use, with no absolute maximum: web has a seven-day inactivity window, browser and Desktop 30
days, and mobile 60 days. Self-hosted operators can override sliding and absolute lifetime settings.
([static client configuration](https://github.com/bitwarden/server/blob/ac309aa19ed351406a56032d5f26a7a9a99f4abd/src/Identity/IdentityServer/StaticClientStore.cs),
[token policy](https://github.com/bitwarden/server/blob/ac309aa19ed351406a56032d5f26a7a9a99f4abd/src/Identity/IdentityServer/ApiClient.cs),
[official configuration reference](https://bitwarden.com/help/environment-variables/#refresh-token-variables))

Because both values are bearer credentials, copying one is sufficient to replay it from another
process while it remains accepted. TLS limits network capture but does not make the token key-bound.
The JWT has a `jti` and Device claim, but the inspected request path supplies no client-held key proof.
This is a direct security-property inference from the Bearer header and reusable-refresh configuration,
not an explicit Bitwarden threat statement.

The shared client may keep access and refresh tokens in memory or on disk according to the Vault
timeout action. Where platform secure storage is supported, it stores the refresh token there and
encrypts the access token with a random key held there. If secure storage is unsupported or fails, the
implementation can fall back to disk. This is storage hardening, not cryptographic binding of the token
to the Device.
([client token storage](https://github.com/bitwarden/clients/blob/2992d17688c0ad43afc434da09f9aae9a9f6d996/libs/common/src/auth/services/token.service.ts))

#### Stolen-token consequences

- A stolen access token gives its holder the User's Server-side API authority and access to encrypted
  Vault payloads for at most its remaining one-hour lifetime. It does not by itself reveal the User
  Encryption Key for an ordinary password account.
- A stolen refresh token can mint fresh access tokens. With default reusable sliding expiry and no
  absolute cap, continued use can maintain access indefinitely unless an Account-wide invalidation or
  another policy change rejects it.
- For trusted-device SSO, the bearer token may make the encrypted Device-specific key blobs available,
  but those still require the separate local Device key. Theft of both the bearer credentials and Device
  key crosses that separation.

### Revocation

#### Documented behavior

Bitwarden tells a User who sees an unknown login to change the master password, enable two-step login,
and use “Deauthorize Sessions” to force logout on all Devices. It does not document an ordinary
per-Device session kill in that guidance.
([Bitwarden Security FAQs](https://bitwarden.com/help/security-faqs/))

#### Source-based findings

“Deauthorize Sessions” rotates the User security stamp and pushes logout to all clients. Refresh-token
validation compares the stamp stored in the persisted grant with the current User stamp, so rotation
invalidates all refresh tokens. Already-issued access JWTs remain independently usable until expiry
unless a separate online check rejects them; the inspected one-hour access-token configuration and
refresh validation show no per-request stamp lookup.
([security-stamp endpoint](https://github.com/bitwarden/server/blob/ac309aa19ed351406a56032d5f26a7a9a99f4abd/src/Api/Auth/Controllers/AccountsController.cs),
[stamp rotation and push logout](https://github.com/bitwarden/server/blob/ac309aa19ed351406a56032d5f26a7a9a99f4abd/src/Core/Services/Implementations/UserService.cs),
[refresh-token activity check](https://github.com/bitwarden/server/blob/ac309aa19ed351406a56032d5f26a7a9a99f4abd/src/Identity/IdentityServer/ProfileService.cs))

There is also an authenticated `DELETE /devices/{id}` endpoint. It sets `Active = false`, clears the
three encrypted trusted-device key fields, and unregisters push. It does not rotate the User security
stamp. The Device lookup used during login selects by User ID and identifier without filtering the
active flag. Therefore this endpoint is evidenced as revocation of trusted-device key release and
notification state, not as immediate revocation of that Device's bearer sessions.
([Device controller](https://github.com/bitwarden/server/blob/ac309aa19ed351406a56032d5f26a7a9a99f4abd/src/Api/Controllers/DevicesController.cs),
[Device deactivation](https://github.com/bitwarden/server/blob/ac309aa19ed351406a56032d5f26a7a9a99f4abd/src/Core/Services/Implementations/DeviceService.cs),
[Device lookup query](https://github.com/bitwarden/server/blob/ac309aa19ed351406a56032d5f26a7a9a99f4abd/src/Sql/dbo/Stored%20Procedures/Device_ReadByIdentifierUserId.sql))

### Surface differences

- The core wire protocol is shared: every interactive client uses one-hour Bearer access tokens and
  refresh tokens. The material Server-side difference is the default refresh inactivity window: seven
  days for web, 30 for extension and Desktop, and 60 for mobile.
- Web, extension, and Desktop share the same TypeScript token service. Storage protection varies with
  platform capability and Vault timeout policy; it is not guaranteed. The present mobile clients are
  separate native repositories, so this report does not infer their exact at-rest token container.
- Browser and Desktop use distinct OAuth client IDs but the same Bearer-token pattern. The Server has
  no protocol field that turns one into proof-of-possession.

## Comparison with Bittery's settled constraints

### One protocol across Web, Desktop, and Extension

Both products show this is practical. 1Password applies the same SRP-derived request binding to its web
and native clients, while Bitwarden shares one OAuth Bearer flow and mostly one client implementation.
Platform storage strength can still differ without changing the wire protocol. Bittery should specify a
single credential protocol and keep local key protection as a separate adapter concern.

### Account-signed Device Grant

Neither product provides direct precedent for Bittery's durable, Account-signed Device Grant.
1Password password enrollment authenticates with the Account password and Secret Key; its SSO path
authorizes transfer from a linked client through CPace. Bitwarden creates a Server Device row after
authentication and later trusts Server-signed token claims. In both, the Server's Device database is
authoritative. Bittery's grant is stronger against a Malicious Operator because any client can verify
that the Account signing key, not merely the Server, admitted the credential public key.

### Server-issued credential cannot obtain Account keys by itself

Bitwarden provides the cleanest partial analogue: bearer tokens fetch encrypted Vault material, but a
password account still needs the locally derived User Encryption Key. Its optional trusted-device path
also needs a local Device key to open the Server-held key blobs. 1Password's password path similarly
separates a live session key from the AUK, although the same two human/device secrets derive both.
By contrast, 1Password's SSO Device key protects a credential bundle that contains the AUK itself; once
the Server releases that bundle after authorization, Device-key possession participates directly in
Account-key recovery. Bittery should retain the stricter separation already settled: the ordinary
Server credential must never be the key-release factor.

### Explicit Device revocation

1Password's per-linked-client unlink is the closer product precedent, but its public protocol omits
session timing. Bitwarden's ordinary emergency control is Account-wide; its per-Device deactivate path
does not revoke bearer sessions. Bittery therefore needs an explicit Server-side credential status per
Device, rejection of new sessions immediately after revocation, and a stated bound for already-issued
sessions. Local ciphertext and Account keys already obtained by a revoked Device remain outside what
Server revocation can erase.

### Malicious Operator

1Password demonstrates two useful mechanisms: every request can be cryptographically bound to the
authentication exchange, and the CPace enrollment channel can detect a Server that alters the
handshake. It also documents the unavoidable web-delivery weakness: a malicious Server can serve a
client that steals secrets. Bitwarden's bearer tokens and Server-authoritative Device rows provide no
client-verifiable admission evidence against the operator. Encryption still prevents either product's
honest Server database from yielding plaintext Vaults, but that is a different property from proving
which Device the Account authorized.

## Design implications, not a decision

1. The established patterns support two coherent choices for ordinary traffic: a session key derived
   from a Device-authentication handshake, as in 1Password, or short access Bearer tokens backed by a
   long refresh Bearer token, as in Bitwarden. Only the former is proof-of-possession by construction.
2. A public Device identifier is metadata, not credential material. It can index a Device record and
   appear in a session, but treating knowledge of it as “known Device” creates no cryptographic
   assurance.
3. If Bittery uses a Server-issued token, binding token issuance and every request to the private key
   named by the Account-signed Device Grant avoids Bitwarden's replay consequences. A short Bearer
   lifetime alone only bounds them.
4. Credential revocation and session revocation need separate rules. Specify whether revocation kills
   all outstanding sessions immediately or at a bounded recheck, and whether refresh or rekey can
   resurrect them.
5. Rotation needs two independent stories: rotate the Server authentication credential without moving
   Account keys, and rotate Account keys when a Device may already possess them. Neither product can
   make an offline stolen Device forget keys it already obtained.
6. Keep surface-specific persistence out of the wire protocol. Web may have no hardware keystore;
   Desktop and mobile may. The credential protocol should remain identical and explicitly tolerate
   weaker local storage without pretending it creates hardware binding.

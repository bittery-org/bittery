# Bittery

A self-hosted, open-source password manager. Users hold Items in Vaults, share Vaults through Teams,
and synchronize through a Server that cannot read what it stores.

This glossary grows lazily. Terms arrive as Wayfinder tickets resolve them, so absence means
undecided, not unimportant.

## Adversaries

**Curious Operator**:
The person running a Server, reading its database, backups, and logs without modifying its code.
_Avoid_: honest-but-curious server, passive admin

**Malicious Operator**:
The person running a Server, modifying its code, forging its responses, and replaying its state.
Bittery treats every operator as potentially this one.
_Avoid_: evil server, hostile admin, compromised host

**Network Attacker**:
An attacker who controls the path between a client and a Server.
_Avoid_: man in the middle, MITM

**Device Thief**:
Someone in physical possession of an enrolled Device.
_Avoid_: stolen device attacker, local attacker

**Co-tenant User**:
A User of the same deployment who is not a member of the Vault in question.
_Avoid_: other tenant, neighbour account, same-server user

**Compromised Client Build**:
A released client binary or bundle that is not the one the published source produces.
_Avoid_: supply chain attack, poisoned build

## Guarantee tiers

**Prevented**:
An attack that cannot succeed against a conforming build.
_Avoid_: blocked, impossible, mitigated

**Detectable**:
An attack that can be attempted, and that the User's own client catches and reports.
_Avoid_: audited, logged, noticed

**Acknowledged**:
An attack the product does not defend against and states plainly in documentation.
_Avoid_: accepted risk, out of scope, residual risk

## Privacy

**Server-visible plaintext**:
The closed set of fields a Server holds unencrypted, enumerated by `PRIVACY-007`. Anything absent
from that set is a defect.
_Avoid_: metadata, leakage surface, clear fields

**Operator Log**:
The audit stream an administrator can read. Carries Account identifiers and event categories, never
the Vault or Item an event touched.
_Avoid_: admin log, system log, server audit

**Security History**:
The audit stream encrypted to a User or Team, naming the actor and object of each event. An
administrator cannot read it.
_Avoid_: user audit log, activity feed, account history

**Revision chain**:
The hash linking each Item revision to the one before it, so that dropping or reordering a revision
is Detectable.
_Avoid_: history hash, version chain, merkle log

## Clients

**Installed client**:
A released, signed Desktop or Extension build. It is obtained once from a published artifact, so its
integrity does not depend on any Server. Only an installed client holds Accounts from more than one
Server.
_Avoid_: native client, app, desktop app

**Web client**:
The browser client a Server serves at its own origin. It is re-fetched on every load from that
Server, so it holds only that Server's Accounts and its integrity depends on that operator per load.
_Avoid_: web app, browser client, PWA

**Serving operator**:
The operator of the Server that delivered the running Web client. For an installed client there is no
serving operator.
_Avoid_: host, page owner

## Authentication

**Full sign-in**:
The exchange that proves possession of the master password and the Secret Key to a Server. It runs at
Device enrolment and whenever a Device has no valid Device credential. Ordinary traffic never uses it.
_Avoid_: login, log in, authentication (as a noun for this specific exchange)

**Authentication Key**:
The Ed25519 key pair derived from the master password and the Secret Key. Its private half exists only
in memory during a full sign-in; the Server holds the public half and nothing else.
_Avoid_: auth key, login key, verifier, password verifier

**Sign-in Challenge**:
The single-use nonce a Server issues to begin a full sign-in. The client returns a signature over a
canonical message binding the nonce, the Server, the Account, the protocol version, and a purpose
label.
_Avoid_: challenge token, login token, nonce (unqualified)

**Authentication profile**:
The identifier of the published key-derivation parameters an Authentication Key was derived under. It
is not secret. Devices hold it locally and the Emergency Kit prints it, because the Server cannot
supply it before a full sign-in begins.
_Avoid_: KDF version, work factor, difficulty

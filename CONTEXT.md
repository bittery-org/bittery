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

# Future grilling sessions

Start each topic in a fresh conversation so its decision tree has focused context. A session reads the
root greenfield README, authoring rules, relevant target/current-state documents, and this file. It
does not load unrelated branches.

## Session protocol

1. Establish facts from the frozen repository and primary external sources. Agents research facts;
   the user decides trade-offs.
2. Map the topic as a decision tree.
3. Ask one frontier round at a time, with one opinionated recommendation per question.
4. Challenge terminology and cross-check it against the current glossary and accepted candidates.
5. Stop when the frontier is empty or the user explicitly ends the session.
6. Write outcomes as Candidate decisions, target changes, scenarios, and open questions.
7. Run a contradiction check against all existing Candidate and Accepted material.
8. Do not implement product code during specification grilling.

## Recommended session order

1. Threat model and security promises.
2. Authentication, OPAQUE, KDF, and key hierarchy.
3. Recovery, Device enrollment, quick unlock, and revocation.
4. Replica schema, operation state machine, and crash safety.
5. Sync protocol, conflicts, cursor/bootstrap, and multi-Device simulations.
6. Vault/Team authorization, departure, and key rotation.
7. Share links and external recipients.
8. All Accounts, Collections, search, and cross-Server copying.
9. Attachments, offline pinning, quotas, and garbage collection.
10. Server domain architecture, SQLx, deployment, backup, and operations.
11. Web/Effect/Worker architecture.
12. Extension/autofill/native-messaging architecture.
13. Desktop/Tauri architecture.
14. iOS/AutoFill architecture.
15. Android/Credential Manager architecture.
16. UI system, accessibility, localization, and user journeys.
17. First-release scope and final consistency review.

## Session handoff template

```markdown
# <topic> candidate decisions

Status: Candidate
Date:
Frozen baseline:

## Facts established
## Decisions made
## Requirements added or changed
## Scenarios added or changed
## Contradictions found
## Deferred branches
## Next dependent sessions
```


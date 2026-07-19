# KDF deployment policy

Bittery supports one persisted password-derivation profile before launch:
PBKDF2-SHA256 with schema version 1 and 600,000 iterations.

Legacy accounts derived with 310,000 iterations are intentionally not upgraded.
Every disposable internal database must be reset before the KDF migration is
applied. The migration refuses to run when legacy user rows exist and does not
delete those rows itself. Before migration, operators must confirm the reset
precondition with:

```sql
SELECT COUNT(*) AS legacy_user_count FROM "user";
```

The result must be zero. Transparent login re-derivation from issue #34 is not
implemented because no legacy account remains supported after the reset.

Clients accept canonical server profiles from 600,000 through 1,200,000
iterations so a controlled future increase can be processed without accepting
unbounded work factors. Verifier-producing server operations still require the
exact current 600,000-iteration profile.

Known and unknown login responses deliberately expose the same current profile.
Introducing another stored profile requires deterministic decoy profiles or a
different enumeration-resistant negotiation design before deployment.

Android credential-provider password derivation requires synchronized profile
metadata. A missing profile requires reauthentication and is never replaced by
an implicit default.

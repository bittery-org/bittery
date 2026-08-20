# The Server may store operational timestamps

Status: accepted

The earlier sequence-only design added special retention buckets and removed ordinary timestamps
while request handling still exposed activity time to the operator. Bittery now permits wall-clock
timestamps for Server records, retention, expiry, access, audit, and operations, and discloses that
chronology. User-authored Item timestamps remain encrypted. This chooses a conventional, operable
schema over a partial timing-hiding claim and supersedes ADR-0002.

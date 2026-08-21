# Browser transaction completion is an honest weaker durability floor

Status: accepted

Bittery accepts `browser-transactional` as the Web and Extension storage floor because no browser
primitive provides the native on-disk acknowledgement required by `native-crash-durable`. Both
browser hosts use IndexedDB with `durability: "strict"`; OPFS would add hosting and transactional
surface without strengthening the documented guarantee. Web requests persistent Origin storage as
best effort, the Extension requires `unlimitedStorage`, and neither is represented as protection
from explicit clearing, Extension removal, browser policy, or storage forensics.

## Consequences

All hosts remain offline-first, so a browser Origin removed before Sync can take the only known copy
of an Unsynced operation. Bittery makes that state persistent and visible, and its own Account
removal, Device wipe, and reset flows must Sync first or obtain explicit confirmation of the exact
operation count being discarded. One semantic conformance corpus remains shared, with mandatory
`native-crash-durable` and `browser-transactional` profiles for the physical failure claims that
cannot honestly be identical.

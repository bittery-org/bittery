# Golden documents for the native-host seam

Two documents cross from TypeScript into Rust as JSON, with no generator between them:
`bittery_native_view` (published by `AccountStore`) and the ItemCache `meta` record it points
at. TypeScript is the producer and Rust the consumer, so ts-rs is the wrong direction —
generating Rust from TypeScript would put the definition on the wrong side of the seam, and
generating TypeScript from Rust would invert who owns the format.

These files close the gap instead. Each one is a complete, realistic document, and it is
asserted from **both** ends:

| side | test | what it proves |
| --- | --- | --- |
| TypeScript | `packages/storage/src/native-host-view.golden.test.ts` | the publisher emits exactly this document |
| Rust | `apps/desktop/src-tauri/src/lib.rs` (`golden_*` tests) | the consumer accepts it and reads every field |

A field added, renamed, retyped or dropped on either side fails one of the two. A field
added to **both** sides without updating the fixture fails the TypeScript one, because it
compares the whole document rather than the fields it happens to care about.

The version numbers in the filenames are `NATIVE_VIEW_VERSION` and `ITEM_CACHE_STATE_VERSION`.
Bumping either means adding a new fixture beside the old one, not editing it in place —
the Rust side refuses a document whose version it does not recognise, and the point of the
old file is to prove what that refusal is refusing.

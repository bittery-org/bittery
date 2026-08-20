# Sentinel and password generation

Type: grilling
Status: ready-for-human
Blocked by: 31

## Question

Sentinel is first-release on Web and Desktop, not Extension. Two frozen-product facts matter: Sentinel is web-only today and plan-gated in cloud mode, so this is mostly new work; and the password generator lives in TypeScript at `packages/shared/src/password.ts`, is **modulo-biased** (`charSet[val % charSet.length]` over alphabets that do not divide 256), reuses one random buffer for its shuffle, and sits entirely outside the audited Rust core. Neither appears in the disposition table.

Decide:

- Where password generation lives. The engine is the obvious answer, and it must be unbiased.
- The generator's options: length, alphabets, passphrase mode, wordlist source, and pronounceable variants.
- What Sentinel analyses: weak, reused, old, and whether anything else.
- Whether breach detection is in scope at all. It does not exist in the frozen product, only a plan doc and an enum value, and it needs an external service that `HOST-006` makes opt-in.
- Sentinel's scope under `ACCOUNT-003`, and its cost on a large Vault.

Produces: a generator specification, `SENTINEL-*` requirements, and two missing disposition rows.

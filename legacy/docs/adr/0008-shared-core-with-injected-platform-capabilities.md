# Four clients share `packages/core`, and platform capabilities arrive by injection

Web, desktop, mobile and the extension all drive the same vault logic, so it lives once in
`@bittery/core`, and nothing in that package imports a platform module —
`services/autolock-mobile.ts` goes as far as resolving `react-native` through a runtime
`require` to keep it out of the dependency graph. Each app instead wraps its root in
`PlatformProvider` (`apps/{web,desktop,mobile,extension}/src/providers/platform-provider.tsx`)
and injects its `AccountStore`, `ItemCache`, `ICrypto`, sync and autolock implementations;
`createCoreContext` wires the services from those. Four divergent copies of unlock, sharing
and item mutation was the alternative, and in a password manager a behavioural drift between
platforms is a security bug, not a UX inconsistency.

The package therefore has two classes of entry point and the split is load-bearing:
`@bittery/core/services/*` is React-free and is what the MV3 service worker imports (it
imports no hook), while `@bittery/core/hooks/*` is React-shaped and used only by UI. React is
a peer dependency, which pins the whole shared layer to a React-family UI on every platform.
`3fab6b66` split the barrel into per-module subpaths so a consumer pulls exactly what it
needs; the `noRestrictedImports` entries in `biome.json` catch the removed aliases.

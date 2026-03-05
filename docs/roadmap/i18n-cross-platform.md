## Cross-App i18n Extraction and Adapter Migration (Desktop + Mobile First)

### Summary

- Extract web-specific i18n logic from:
  - apps/web/src/lib/i18n-format.ts (/Users/juliansigmund/Desktop/bittery/apps/web/src/lib/i18n-format.ts)
  - apps/web/src/lib/i18n-locale.ts (/Users/juliansigmund/Desktop/bittery/apps/web/src/lib/i18n-locale.ts)
  - apps/web/src/providers/i18n-provider.tsx (/Users/juliansigmund/Desktop/bittery/apps/web/src/providers/i18n-provider.tsx)
- Move reusable logic into @bittery/i18n using an adapter-based core plus a shared React provider factory.
- Keep Paraglide runtime generated per app (your decision), with desktop/mobile added now and extension/marketing deferred to phase 2.
- Standardize runtime behavior across apps: locale resolution/persistence managed by shared core, not by Paraglide strategy.

### Public API / Interface Additions

- Add new exports in packages/i18n/src/index.ts (/Users/juliansigmund/Desktop/bittery/packages/i18n/src/index.ts):
  - resolveBrowserLocale(browserLocale)
  - resolveLocale({ storedLocale, browserLocale })
  - persistLocaleSelection({ locale, runtime, storage, storageKey })
  - initializeLocale({ runtime, storage, detectLocale, storageKey })
  - createI18nFormatters(getLocale)
  - createI18nReact<M>({ messages, runtime, storage, detectLocale, sideEffects })
- Add adapter types:
  - LocaleRuntimeAdapter:
    - getLocale(): AppLocale
    - setLocale(locale: AppLocale, options?: { reload?: boolean }): void | Promise<void>
  - LocaleStorageAdapter:
    - getItem(key: string): string | null | Promise<string | null>
    - setItem(key: string, value: string): void | Promise<void>
  - LocaleEnvironmentAdapter:
    - getBrowserLocale(): string | null | undefined
    - applyLocale?(locale: AppLocale): void (for <html lang> / RN side effects)
- Package export map update in packages/i18n/package.json (/Users/juliansigmund/Desktop/bittery/packages/i18n/package.json):
  - . -> current + new core exports
  - ./react -> React provider factory entry
  - ./format -> formatter entry (optional split, but fixed as part of this plan)

### Implementation Plan

1. Create shared i18n core in package

- Add files under packages/i18n/src/:
  - locale-resolution.ts (from current web resolveBrowserLocale and resolveLocale)
  - locale-persistence.ts (generalized persistLocaleSelection and initializeLocale)
  - formatters.ts (from current web i18n-format.ts, rewritten as createI18nFormatters(getLocale))
  - adapters.ts (runtime/storage/environment interfaces)
  - react/create-i18n-react.tsx (provider + hook factory)
- Keep supportedLocales, AppLocale, defaultLocale, localeStorageKey, isAppLocale in root exports for compatibility.

2. Refactor web to consume package APIs

- Replace logic in:
  - apps/web/src/providers/i18n-provider.tsx (/Users/juliansigmund/Desktop/bittery/apps/web/src/providers/i18n-provider.tsx)
  - apps/web/src/lib/i18n-locale.ts (/Users/juliansigmund/Desktop/bittery/apps/web/src/lib/i18n-locale.ts)
  - apps/web/src/lib/i18n-format.ts (/Users/juliansigmund/Desktop/bittery/apps/web/src/lib/i18n-format.ts)
- Web provider becomes thin composition:
  - runtime adapter from @/paraglide/runtime
  - storage adapter from window.localStorage
  - environment adapter from window.navigator.language + document.documentElement.lang
  - messages from @/paraglide/messages

3. Desktop app integration

- Add Paraglide generation in apps/desktop/vite.config.ts (/Users/juliansigmund/Desktop/bittery/apps/desktop/vite.config.ts):
  - project: ../../packages/i18n/project.inlang
  - outdir: ./src/paraglide
  - strategy: ["baseLocale"] (single source of locale persistence in shared adapter layer)
- Add @bittery/i18n + @inlang/paraglide-js dependencies to desktop package.
- Add apps/desktop/src/providers/i18n-provider.tsx as thin adapter composition using shared createI18nReact.
- Wrap root render in apps/desktop/src/main.tsx (/Users/juliansigmund/Desktop/bittery/apps/desktop/src/main.tsx) with desktop i18n provider.
- Add desktop formatter utility re-export from shared createI18nFormatters and replace hardcoded locale/date calls incrementally (start with
  known Intl/toLocale\* occurrences).

4. Mobile app integration

- Add @bittery/i18n + @inlang/paraglide-js dependencies to mobile package.
- Add script apps/mobile/scripts/generate-i18n.mjs to generate apps/mobile/src/paraglide.
- Commit generated apps/mobile/src/paraglide/\* (your decision).
- Add script hooks in apps/mobile/package.json (/Users/juliansigmund/Desktop/bittery/apps/mobile/package.json):
  - i18n:generate
  - i18n:check-generated (CI drift check)
- Add i18n provider at apps/mobile/app/\_layout.tsx (/Users/juliansigmund/Desktop/bittery/apps/mobile/app/\_layout.tsx) using shared
  createI18nReact.
- Use AsyncStorage adapter (@react-native-async-storage/async-storage) for locale persistence with key bittery.locale.
- Add Metro alias resolution for @bittery/i18n in apps/mobile/metro.config.js (/Users/juliansigmund/Desktop/bittery/apps/mobile/
  metro.config.js) alongside existing workspace package mappings.

5. Paraglide strategy normalization

- Web currently uses localStorage strategy in Vite config; change to ["baseLocale"] so:
  - Paraglide runtime only handles message lookup/runtime switching.
  - Shared adapter layer handles locale selection order and persistence in all apps.
- Apply same strategy on desktop and mobile generation for consistent semantics.

6. Cleanup and compatibility

- Keep backwards-compatible exports in @bittery/i18n so existing imports (defaultLocale, AppLocale, etc.) do not break.
- Keep existing web useI18n API shape unchanged ({ locale, setLocale, m }) to avoid broad call-site churn.
- Defer extension/marketing rollout; design remains reusable for them.

### Test Cases and Scenarios

1. Package unit tests (new)

- resolveBrowserLocale:
  - de-DE/de-AT -> de
  - unknown/undefined -> en
- resolveLocale:
  - valid stored locale wins over browser locale
  - invalid stored locale falls back to browser resolution
- initializeLocale:
  - stored locale path
  - browser fallback path
  - default fallback path
- persistLocaleSelection:
  - storage write called with bittery.locale
  - runtime setLocale(..., { reload: false }) called

2. Web regression checks

- Existing i18n locale tests continue passing after extraction.
- Language switch in settings still persists and updates immediately.
- <html lang> still mirrors active locale.

3. Desktop integration checks

- App starts with default locale when no stored value.
- Locale change updates messages and survives restart.
- Date/number formatting reflects active locale.

4. Mobile integration checks

- i18n:generate produces committed runtime files.
- On app boot, locale resolves from AsyncStorage, then device locale, then default.
- Locale change updates active UI copy and persists across app relaunch.

5. CI checks

- pnpm i18n:check
- pnpm --filter @bittery/i18n check-types
- pnpm --filter web check-types
- pnpm --filter mobile i18n:check-generated

### Assumptions and Defaults

- Scope now: desktop + mobile first; extension/marketing later.
- Runtime choice: Paraglide in all non-web apps as well.
- Generation model: per-app Paraglide runtime generation.
- Mobile generated files are committed and checked for drift in CI.
- Locale key remains bittery.locale across apps.
- Default locale remains en.
- Locale resolution priority remains:
  1. stored user locale
  2. environment/device/browser locale
  3. defaultLocale

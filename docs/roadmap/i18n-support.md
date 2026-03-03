 ## TanStack Start SPA i18n Plan (Web First, Shared Source, EN/DE)

  ### Summary

  Adopt Paraglide JS as the i18n system for apps/web, with translations stored in a shared workspace package and compiled per app.
  This matches current TanStack guidance and gives typed, tree-shakable messages with low runtime overhead, while keeping future apps free to
  use different locale strategies.

  Decision basis (as of March 3, 2026):

  - TanStack i18n guide recommends Paraglide: https://tanstack.com/start/latest/docs/framework/react/guide/i18n
  - TanStack + Paraglide Start example: https://tanstack.com/start/latest/docs/framework/react/examples/start-basic-react-with-paraglide
  - Paraglide localStorage strategy (fits your no-prefix choice): https://inlang.com/m/gerre34r/library-inlang-paraglideJs/localstorage-
    strategy
  - Paraglide monorepo guidance (shared source, per-app compile option): https://inlang.com/m/gerre34r/library-inlang-paraglideJs/monorepo

  ### Architecture

  1. Create shared translation source package:

  - packages/i18n/
  - packages/i18n/messages/en.json
  - packages/i18n/messages/de.json
  - packages/i18n/project.inlang/settings.json
  - packages/i18n/package.json (source-only package, not app runtime)

  2. Compile Paraglide runtime in apps/web from shared source:

  - Add Paraglide Vite plugin to apps/web/vite.config.ts.
  - Input project: ../../packages/i18n/project.inlang
  - Output directory: apps/web/src/paraglide
  - Strategy: localStorage/browser preference (no URL prefix).

  3. Add web i18n runtime bridge:

  - apps/web/src/providers/i18n-provider.tsx
  - Responsibilities:
      - initialize locale before first render (en fallback),
      - persist selection in localStorage,
      - expose useI18n() hook (locale, setLocale, m),
      - sync <html lang> with active locale.

  4. Integrate provider at router root:

  - Wrap app in I18nProvider in apps/web/src/router.tsx Wrap.
  - Update apps/web/src/routes/__root.tsx to use runtime locale for <html lang>.

  5. Introduce a language switch UI (web-only for now):

  - Add selector in settings page (apps/web/src/routes/_app/settings/index.tsx), EN/DE.
  - Immediate language switch without navigation/path changes.

  6. Migrate strings in phases:

  - Phase 1: auth + nav + settings + shared dialogs used most.
  - Phase 2: dashboard, vault flows, billing/team/admin.
  - Replace hardcoded date/number/currency formatting with locale-aware helpers.

  ### Public APIs / Interfaces / Types

  New shared package surface (packages/i18n):

  - supportedLocales: readonly ["en", "de"]
  - type AppLocale = "en" | "de"
  - defaultLocale = "en"
  - message source JSON schema conventions (namespaced keys)

  New web-facing API:

  - useI18n() from apps/web/src/providers/i18n-provider.tsx
      - returns:
          - locale: AppLocale
          - setLocale(locale: AppLocale): void
          - m: generated Paraglide message object (typed message functions)

  Formatting helpers (web):

  - formatDate(value, options?)
  - formatDateTime(value, options?)
  - formatNumber(value, options?)
  - formatCurrency(value, currency, options?)
    All helpers resolve current locale from i18n runtime.

  ### Implementation Details (Decision-Complete)

  1. Dependencies:

  - Add to apps/web: @inlang/paraglide-js, @inlang/paraglide-js-adapter-react, @inlang/paraglide-vite (exact package names/versions per current
    registry at implementation time).

  2. Locale resolution order:

  - explicit user selection in localStorage key bittery.locale
  - browser locale match (de-* -> de, else en)
  - fallback en

  3. Message key conventions:

  - domain-first namespacing: auth.login.title, settings.language.label, etc.
  - no sentence-as-key.

  4. Missing translations policy:

  - fail CI on missing required locale keys.
  - fallback to en at runtime for optional misses.

  5. Route strategy:

  - keep existing route tree unchanged (no /de/... paths).

  6. Cross-app reuse:

  - other apps consume packages/i18n message source and compile locally when adopted.
  - avoid locking all apps to one runtime strategy.

  ### Test Cases & Scenarios

  Unit:

  1. Locale resolver picks de for de-DE, otherwise en.
  2. setLocale("de") persists and updates runtime locale.
  3. Formatting helpers output locale-correct date/number/currency.

  Component/integration:

  1. Settings language toggle updates visible strings immediately.
  2. <html lang> updates to de and back to en.
  3. No route/path changes when toggling language.

  E2E (Playwright):

  1. User selects German, reloads, German persists.
  2. Auth page + sidebar + settings render German after toggle.
  3. Existing navigation/auth guards continue working unchanged.

  Static checks:

  1. Script to validate key parity between en.json and de.json.
  2. CI check fails on missing/extra key drift (unless explicitly allowed list).

  2. Locale preference persists across sessions.
  3. Core UX text (auth/nav/settings) is translated in v1.
  4. Date/number/currency formatting honors active locale.
  5. Shared translation source is in packages/i18n and ready for other apps.

  ### Assumptions & Defaults

  - Assumption: no locale-in-URL requirement (confirmed by you).
  - Default locale: en.
  - Initial rollout scope: apps/web only, with shared source prepared for multi-app reuse.
  - Assumption: SPA mode remains enabled; no server-side locale negotiation is needed.
  - Default translation workflow: manual key authoring now; automated extraction can be added later if desired.
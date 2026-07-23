# apps/marketing is exempt from the strict i18n rule

`apps/marketing` contains no paraglide/i18n usage; the marketing site is intentionally English-only. The CLAUDE.md rule "never hardcode any user facing text" applies to the product apps (desktop, web, extension), not the marketing site. Confirmed during the roadmap-redesign discovery (2026-07-23) — grep for `paraglide|@bittery/i18n` over `apps/marketing` returns nothing.

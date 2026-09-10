/**
 * Re-export only. The wiring lives in `@bittery/i18n/react/browser`, which web,
 * desktop and the extension all share; this file exists so the ~108 call sites
 * across the three apps keep importing i18n from their own providers directory.
 */
export { I18nProvider, useI18n } from "@bittery/i18n/react/browser";

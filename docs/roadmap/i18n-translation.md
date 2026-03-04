Internationalize this new feature/route end-to-end.

We use Paraglide JS for i18n. Reuse any existing keys if they fit the context, but create new ones if needed. Follow the existing key naming conventions and structure.

Requirements:

1. Replace all user-facing hardcoded strings with i18n keys. (packages/i18n/messages/en.json and de.json, etc.)
2. Add/update translations in the available languages.
3. Keep naming consistent and scoped to the feature.
4. If non-UI layers generate English copy, refactor them to return stable keys/params and localize only in the UI.
5. Handle count-based singular/plural copy correctly.
6. Preserve behavior and design; only change what’s needed for i18n.
7. Run i18n parity checks, dont compile, dont build anything, just check types.

Output:

- What was changed
- Any remaining hardcoded user-facing strings

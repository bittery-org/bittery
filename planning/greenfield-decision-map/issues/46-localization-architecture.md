# Localization architecture and string ownership

Type: grilling
Status: ready-for-human
Blocked by: 38, 44

## Question

The frozen product ships English and German only. The engine and binding seam decides who owns user-facing strings, and it is expensive to retrofit.

Decide:

- Whether the engine emits translatable message keys or human strings, and what that means for closed outcome types crossing the FFI.
- Where the message catalogue lives, and whether native hosts share it.
- Locale-sensitive formatting for dates, numbers, and relative times, and who does it.
- The launch locale set, and how a locale is added later without touching the engine.
- Right-to-left support, and whether it is in the first release.
- What is deliberately not translated, such as security-critical terminology.

Produces: an `I18N-*` requirement family and a boundary rule.

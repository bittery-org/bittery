# Bittery Mobile (Tauri) — Brand-Forward in a WebView

The WebView translation of `apps/mobile/DESIGN-NATIVE.md`. Same system, same vocabulary,
same phone ergonomics — read that file first. This one only says what changes when the
renderer is a WebView instead of React Native.

Machine-readable source of truth: `src/styles.css` (tokens) and `src/components/ui/` (the
kit). Colour values themselves come from `packages/ui/src/tokens.css`, shared with desktop,
web and the extension.

## Non-negotiables

1. **Never hardcode a colour.** Use the semantic Tailwind class (`bg-surface`,
   `text-muted-foreground`, `border-border`).
2. **Never restyle a kit primitive ad hoc.** If a screen needs a variant, add it to the
   primitive in `src/components/ui/` so every screen inherits it.
3. **Purple is not ambient.** It belongs to primary actions, focus, selection, indicator
   bars, and the sanctioned brand moments. Everything else is neutral.
4. **No `useEffect`.** Derive during render, use event handlers, or use React Query.
5. **Strict i18n.** No literal user-facing strings — including `aria-label`s, placeholders
   and empty-state copy.
6. **Both themes.** Every screen is checked in light and dark.

## The one naming difference from the native doc

The native doc calls purple `accent`, because that is what HeroUI Native calls it. **Here
purple is `primary` / `primary-deep`.** In the shared token file `--accent` is already
taken: it is shadcn's *neutral* hover grey. Do not add an `accent` alias — it would mean the
opposite thing on the two halves of the same repo.

| Native doc says | Write this here |
|---|---|
| `accent` | `primary` |
| `accent-deep` | `primary-deep` |
| `muted` (text) | `muted-foreground` |
| `danger` | `danger` (aliased to `--destructive`) |
| `field-background` | `field` |
| `surface` / `-secondary` / `-tertiary` | same |
| `separator` | `separator` |

## Elevation ladder

`bg-background` (0, canvas) → `bg-field` (1, inputs and inset wells) → `bg-surface` (2,
cards and grouped lists) → `bg-surface-secondary` (3, sheets and menus) →
`bg-surface-tertiary` (4, pressed state *inside* a sheet, chips on sheets).

Status tints are `bg-danger-soft`, `bg-success-soft`, `bg-warning-soft`, `bg-info-soft`,
`bg-primary-soft` — a coloured glyph over a soft wash, never a saturated fill on a large
area.

## What the WebView changes

- **Type scale is retuned for touch.** `src/styles.css` overrides the shared 13px desktop
  base with the native ladder: `text-base` is 15px, `text-lg` 17px, `text-3xl` 28px. Do not
  read desktop's scale into a mobile screen.
- **Press feedback is hand-tracked.** A WebView applies `:active` only after it has decided
  the gesture is not a scroll, roughly 100ms late, and that lag is the single loudest "this
  is a website" tell. `Pressable` listens for `pointerdown` itself and releases on
  `pointercancel`, so a flick down a list does not light up every row it passes. **Use
  `Pressable`, not a bare `<button>`, for anything tappable.**
- **Bars are translucent, not opaque.** `AppBar` and `TabBar` sit on `bg-*/80` plus
  `backdrop-blur-xl`, guarded by `supports-[backdrop-filter]`. Content visibly passing under
  a blurred bar is the cheapest native cue available.
- **Route changes animate through the View Transitions API.** `defaultViewTransition` is on
  in `main.tsx`; the `::view-transition-*` rules live in `styles.css`. It is a cross-fade
  with a small rise, *not* a directional slide — the router does not report push vs pop, and
  a slide that runs backwards on Back is worse than no slide.
- **Scrolling is explicit.** Every scroll region is a bounded `ScreenScroll`, never the page.
  `.native-scroll` carries momentum, `overscroll-behavior: contain` and no scrollbar.
- **WebView chrome is off** in `styles.css`: no tap highlight, no long-press callout, no
  pinch zoom, no text selection outside inputs (`.selectable` opts a secret back in), no
  image dragging.
- **Browser floor.** `vite.config.ts` transpiles JS to `chrome87` for `minSdk 24`, but the
  *CSS* floor was already ~Chrome 111 before this design existed: `packages/ui/tokens.css` is
  entirely `oklch()`, and the app already used `dvh`. `color-mix()` and View Transitions sit
  at the same 111. Any Play-updated Android WebView is far above this. Do not "fix" the
  colour tokens to widen support without first raising it with the whole repo.

## Layout constants

`src/components/ui/theme.ts` holds them; `--app-bar-height` (52) and `--tab-bar-height` (54)
are also CSS variables because scroll padding and the FAB need them.

Screen padding 16 · card padding 14 · row min-height 56 (two-line) / 48 (single-line) · icon
tile 40 in rows, 56 in headers · gap rhythm 8 / 12 / 16 / 24 · sections separated by 24.

Radius: `rounded-lg` chips · `rounded-xl` buttons, inputs, icon tiles · `rounded-2xl` grouped
cards and sheets · `rounded-full` pills, avatars, FAB.

Every scroll region ends clear of the chrome below it — pass `inset="tabBar"` on a tab root,
`inset="plain"` on a pushed screen.

## Information architecture

Three tabs, matching `apps/mobile`:

| Tab | Route | Contents |
|---|---|---|
| Items | `/vault/all-items` | aurora, search action, category chips, sectioned list, FAB |
| Browse | `/vault` | segmented **Vaults / Tags** |
| Settings | `/vault/settings` | grouped cards |

**Search is a mode of Items**, not a destination: the app-bar action swaps the bar for a
focused field. **Trash is not a tab** — it is rare and reversible, and lives in the account
sheet and in Settings. Both stay routable (`/vault/search`, `/vault/trash`, `/vault/tags`)
so Browse, the account sheet and deep links can push into them.

The account avatar in the app bar opens `AccountSwitcher`: switch account, add account,
settings, trash, lock. `TabScreen` renders it on every tab root, so no screen adds it.

## Brand moments (the only sanctioned ambient purple)

1. **Screen aurora** — `<Aurora />`, a radial `primary-deep` wash pinned to the top, fading
   by ~220px. Items, Browse, auth and unlock only.
2. **Sheet header** — the wash + hairline every `MobileSheet` paints (`brandAccent`).
3. **Selection tint + `<GlowBar />`** — `bg-selected` plus a 1px `primary/15` ring, never a
   solid fill and never flipped text.
4. **Icon tiles** — `<GradientTile />`, a deterministic 135° gradient from the shared
   17-colour name hash, with a 12% inset ring instead of a border. Accounts always use the
   purple gradient, never a hashed one.
5. **Item detail header** — a radial `primary-deep` glow behind the title and a purple halo
   on the icon tile.

Anything else purple needs sign-off.

## Motion

220ms on `ease-native` (`cubic-bezier(0.32, 0.72, 0, 1)`). Press scale 0.985. Skeletons
pulse; nothing else loops. No spring, no bounce, no attention-seeking entrances. The whole
system is disabled under `prefers-reduced-motion`.

## Iconography

`@bittery/ui/icons` — never `lucide-react` directly in a screen. Sizes come from `iconClass`:
`chip` 16 in chips, `row` 18 in rows, `bar` 20 in bars, `header` 24 in headers. Never
override `strokeWidth`.

## Verification

```sh
pnpm exec turbo -F mobile check-types
pnpm exec biome check --write <files you touched>
```

A dev server is always running; skip builds unless asked. The app cannot boot in a plain
browser — `initializeStorage()` needs the Tauri plugins — so visual checks happen on device.

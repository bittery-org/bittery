# Bittery Mobile — Brand-Forward on Native

The native translation of the root `DESIGN.md`. Same system, same vocabulary, phone
ergonomics. Read `DESIGN.md` first; this file only says what changes on React Native
and what the shared mobile kit gives you.

Machine-readable source of truth: `apps/mobile/global.css` (HeroUI Native variables
re-pointed at the Brand-Forward ladder) plus `apps/mobile/src/components/ui/`.

## Non-negotiables

1. **Never hardcode a color.** Use the Uniwind class (`bg-surface`, `text-muted`,
   `border-border`) or `useThemeColor([...])` from `heroui-native` when a native prop
   needs a raw value (shadow colors, `StatusBar`, gradient stops, navigation options).
2. **Never restyle a kit primitive ad hoc.** If a screen needs a variant, add it to the
   primitive in `src/components/ui/` so every screen inherits it.
3. **Purple is not ambient.** Accent belongs to primary actions, focus, selection tint,
   indicator bars, and the sanctioned brand moments below. Everything else is neutral.
4. **No `useEffect`.** Derive during render, use event handlers, or use React Query.
5. **Strict i18n.** No literal user-facing strings, ever — including placeholders,
   accessibility labels, and empty-state copy.
6. **Both themes.** Every screen is checked in light and dark. If you write an arbitrary
   value you owe it a light-mode story.

## Token map (heroui variable → Brand-Forward meaning)

| Variable | Level | Use on mobile |
|---|---|---|
| `background` | 0 | screen canvas |
| `field-background` | 1 | inputs, search field, inset wells |
| `surface` | 2 | cards, grouped list cards, tab bar |
| `surface-secondary` | 3 | bottom sheets, menus, popovers, dialogs |
| `surface-tertiary` | 4 | pressed/hover state *inside* a sheet, chips on sheets |
| `overlay` | 3 | what heroui's own sheet/dialog/menu components paint with |
| `default` | — | neutral pressed state on canvas-level rows |
| `accent` / `accent-deep` | — | primary gradient, focus, selection |
| `selected` | — | the ~10% accent selection surface |
| `border` / `border-strong` | — | hairlines; `border-strong` only on inputs/emphasis |
| `muted` | — | secondary text and rest-state icons |
| `success` `warning` `danger` `info` | — | status only, never decoration |

Light mode mirrors the ladder (cards rise to white above a faintly tinted canvas). It
comes free from `global.css` — do not add per-component light/dark branches for surfaces.

## Scale

- **Radius**: `rounded-lg` 10 (chips, small controls) · `rounded-xl` 15 (buttons, inputs,
  icon tiles) · `rounded-2xl` 20 (grouped cards, sheets, dialogs) · `rounded-full` (pills,
  avatars, FAB).
- **Type** (set in `global.css`): `text-2xs` 10 · `text-xs` 11 · `text-sm` 13 ·
  `text-base` 15 (body) · `text-lg` 17 (row title / nav title) · `text-xl` 20 ·
  `text-2xl` 24 · `text-3xl` 28 (large title) · `text-4xl` 34.
- **Weights**: 400 body · 500 medium (row titles, labels) · 600 semibold (titles, buttons).
  Never 700+.
- **Tracking**: large titles (`text-2xl`+) get `tracking-tight`. Section labels get
  `tracking-[0.06em]`. Body is default.
- **Section label**: `text-2xs font-semibold uppercase tracking-[0.06em] text-muted`.
- **Font**: platform system face (SF Pro / Roboto). Inter ships as `woff2` in
  `packages/ui`, which React Native cannot load — do not try to wire it up without adding
  a real `ttf` asset first.

## Layout constants

- Screen horizontal padding: **16**. Grouped card inner padding: **14**.
- List row min height **56** (two-line) / **48** (single-line); icon tile **40** in rows,
  **56** in headers.
- App bar: one row. A compact title sits in a **44**-tall row; a large title
  instead shares that row with the back affordance, `leading` and `actions`, so a
  screen never spends a whole band on an avatar alone.
- Tab bar: **hairline top border + blur**, content height **52** plus safe-area bottom
  inset. It is not a floating pill.
- Gap rhythm: 8 / 12 / 16 / 24. Sections separated by 24.
- Every scroll view ends with `paddingBottom: 24 + tabBarHeight` so the last row clears
  the tab bar. Use `useBottomInset()` from the kit.

## Recipes

**Grouped card** (the workhorse container — settings groups, field groups, list sections):

```tsx
<ListCard>
  <ListRow title={…} subtitle={…} leading={<IconTile … />} onPress={…} />
  <ListRow … />
</ListCard>
```

`ListCard` paints `bg-surface rounded-2xl border border-border` with hairline dividers
between children and `shadow-surface`. Rows never carry their own border.

**Selection** — tint plus a 1px accent ring, never a solid fill and never flipped text:

```tsx
<View className="bg-selected border border-accent/15 rounded-xl" />
```

plus, on nav/list rows, the glowing indicator: `<GlowBar />` from the kit.

**Press feedback** — neutral. `PressableFeedback` + `PressableFeedback.Highlight` on
canvas rows, `bg-surface-tertiary` inside sheets. Cards additionally scale to `0.985`
over 120ms via `PressScale`. Never a purple press state.

**Primary action** — `BrandButton` from the kit: `accent → accent-deep` vertical gradient,
1px top inset highlight, and a soft accent glow shadow in dark mode. Do not rebuild it
with `<Button variant="primary">` plus classes.

**Floating surfaces** — bottom sheets, menus, dialogs: `bg-surface-secondary`,
`rounded-2xl`, `shadow-overlay`, and a `<SheetBrandAccent />` header wash (see below).

**Inputs** — heroui `TextField` / `SearchField` with the themed field tokens; focus shows
`border-accent` plus a 3px `accent/25` ring. Never a filled purple input.

**Status** — text/icon in the status color over a `*-soft` background
(`bg-success-soft`, `bg-danger-soft`). Never a fully saturated status fill on large areas.

## Brand moments (the only sanctioned ambient purple)

1. **Screen aurora** — `<Aurora />`: a radial `accent-deep` wash pinned to the top of the
   screen, 14% dark / 8% light, fading out by ~220px. Items, Browse, auth and unlock
   screens only.
2. **Sheet / dialog header** — `<SheetBrandAccent />`: an `accent-deep/20` top wash and an
   `accent/55` hairline along the top edge.
3. **Selection tint + `<GlowBar />`.**
4. **Icon tiles** — `<GradientTile />`: deterministic `135°` gradient from the shared
   17-color name hash, `inset 0 0 0 1px rgba(255,255,255,0.12)` instead of a border, white
   glyph. Accounts always use the accent gradient.
5. **Item detail header** — radial `accent-deep` glow behind the title (9% dark / 6%
   light) and an accent halo shadow on the icon tile.

Anything else purple needs sign-off.

## Motion

Reanimated, 120–180ms, `Easing.out(Easing.quad)`. Press scale 0.985. Sheets and menus use
heroui's own timings. Skeletons pulse; nothing else loops. No spring, no bounce, no
attention-seeking entrances.

## Iconography

`lucide-react-native`, imported through `src/components/ui/icons.ts` — never from
`lucide-react-native` directly in a screen. Wrap with `withUniwind` once in that barrel so
call sites can use `className="text-muted"`. Sizes: 16 in chips, 18 in rows, 20 in bars,
24 in headers. Never override `strokeWidth`.

## Information architecture

Four tabs, custom bar, no stock headers anywhere (`headerShown: false` throughout —
screens render `<AppBar />` themselves):

| Tab | Route | Contents |
|---|---|---|
| Items | `(tabs)/index` | aurora, large title, inline search field, category chips, sectioned item list, FAB |
| Search | `(tabs)/search` | focused search field, recent + results, category scoping |
| Browse | `(tabs)/vaults` | segmented **Vaults / Tags**; vault cards with counts, tag rows with color dots |
| Settings | `(tabs)/settings` | the settings screen, grouped cards |

`(tabs)/tags/*` stays routable (Browse pushes into it). `app/settings/index.tsx` and
`(tabs)/settings.tsx` both render the same `SettingsScreen` component — the account sheet
still deep-links to the stack route. Trash stays out of the tab bar, reachable from the
account sheet and from Settings.

## Verification

`pnpm check-types` must pass, and `pnpm biome check --write` on every file you touched.
Never start the dev server; never run a build.

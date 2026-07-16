# Bittery Design System — "Brand-Forward"

This is the design spec for all Bittery UI work. If you are an agent (or human) touching any user-facing surface, follow this document. The visual reference is `docs/design-explorations/3-brand-forward.html` (a static mockup — throwaway code, but the approved look). The machine-readable source of truth is `packages/ui/src/tokens.css`.

## Philosophy

Linear-grade premium: a near-black, cool (hue ~283) dark UI with a strict elevation ladder, hairline borders, 13px base density, and **purple used sparingly** — primary actions, focus rings, and a handful of deliberate "brand moments" (sidebar aurora, selection tint, glow bars). Everything else is neutral. Light mode is derived from the same ladder, never designed separately.

If a change makes purple more ambient (tinted hovers, purple fills on non-primary things), it's wrong.

## Tokens

One file: `packages/ui/src/tokens.css`, imported by all four CSS entries (`apps/desktop/src/styles.css`, `apps/web/src/index.css`, `apps/extension/src/index.css`, `packages/ui/src/index.css`).

- **Never** add color/radius/font tokens to an app CSS file. App files hold only app-specific extras (e.g. `--auth-panel` in desktop + web).
- **Never** hardcode oklch/hex colors in components when a token exists. Arbitrary values are acceptable only for one-off decorative effects (glows, gradients) that compose tokens via `color-mix(...)` or `var(--color-*)`.

### Elevation ladder (dark)

Surfaces get lighter as they rise. Never skip rungs or invent in-between values.

| Level | Token | Dark value | Use |
|---|---|---|---|
| 0 | `bg-background` | `oklch(0.126 0.008 282)` | app canvas, content panes |
| 1 | `bg-sidebar` | `oklch(0.148 0.011 283)` | sidebar |
| 2 | `bg-card` | `oklch(0.172 0.013 283)` | cards, field-row groups |
| 3 | `bg-popover` | `oklch(0.196 0.015 284)` | menus, dialogs, sheets, popovers |
| 4 | `bg-overlay` | `oklch(0.225 0.017 284)` | hover states *inside* popovers, kbd chips on popovers |

Light mode mirrors this (bg `0.985` → sidebar `0.965` → card/popover white) — it comes for free from the tokens; don't add `dark:` overrides for surface colors.

### Key colors

- `primary` — dark `oklch(0.7 0.165 288)`, light `oklch(0.585 0.19 289)`
- `primary-deep` — gradient end / glow source: dark `oklch(0.58 0.185 292)`, light `oklch(0.5 0.2 292)`
- `bg-selected` — the ~9% purple selection surface (`--selected`)
- `border` — hairline alpha: dark `oklch(1 0 0 / 0.07)`, light `oklch(0 0 0 / 0.08)`
- `border-strong` — hover-emphasis borders (inputs, search box)
- `shadow-pop` — the canonical floating-surface shadow (hairline ring + soft drop)
- Status accents are tokens — `success` (green), `warning` (amber), `info` (sky), `destructive` (red). Use `text-success`, `bg-success/10`, `border-success/30` etc.; never raw palette classes (emerald/amber/orange/rose/teal/cyan). Dark values match the mockup (green `oklch(0.72 0.14 160)`, amber `oklch(0.78 0.13 75)`, red `oklch(0.68 0.18 22)`, sky `oklch(0.72 0.12 230)`); light mode uses the same hues stepped down for contrast.

### Scale & type

- `--radius: 0.625rem` → `rounded-sm` 6px (rows, small controls), `rounded-md` 8px (buttons, inputs, tiles), `rounded-lg` 10px (cards, popovers), `rounded-xl` 14px (dialogs).
- `text-sm` is globally **13px** (`0.8125rem` / 18px line-height) and is the app's base size.
- Font is **self-hosted Inter variable** (`packages/ui/src/fonts/`) — never add a font CDN link. Body gets `font-feature-settings: "cv05","cv11"` and `-0.006em` tracking via the base layer; don't repeat those in components.
- Section/group labels: `text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground`.

## Recipes (copy these, don't invent)

**Selection (list rows, nav items, table rows)** — never a solid purple fill, never flipped text color:

```
bg-selected shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_14%,transparent)]
```

plus, on nav/list rows, the glowing indicator bar:

```html
<span aria-hidden class="absolute top-[6px] bottom-[6px] -left-2 w-0.5 rounded-full bg-primary shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_80%,transparent)]" />
```

**Hover** — always neutral: `hover:bg-accent` (or `hover:bg-foreground/4` on plain rows, `hover:bg-sidebar-accent` in the sidebar, `hover:bg-overlay` inside popovers). Never purple.

**Floating surfaces** (menus, popovers, dialogs): `bg-popover rounded-lg border shadow-pop` with ~130ms in/out. Dialogs/sheets use `rounded-xl`.

**Primary button** (already in `packages/ui/src/components/button.tsx` — don't restyle ad hoc): gradient `bg-linear-to-b from-primary to-primary-deep`, inset top highlight, purple outer glow in dark, `hover:brightness-108`.

**Ghost/text buttons**: rest at `text-muted-foreground`, hover to `hover:text-foreground hover:bg-accent`. If a ghost button's label is *primary content* (e.g. the account-switcher trigger), add `text-foreground` explicitly.

**Text/kbd chips**: `border bg-foreground/3 rounded-[4px] text-[10px] text-muted-foreground`.

**Focus**: `focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30` (inputs use `ring-ring/25` with `focus-within`).

**Brand moments** (the only sanctioned ambient purple):
- Sidebar aurora: radial `primary-deep` wash at the top of the sidebar (8% light / 14% dark).
- Account-switcher menu header: `from-primary-deep/20` top wash + a `via-primary/55` hairline top line.
- Dialog headers: the same wash + hairline is built into `DialogContent` and `AlertDialogContent` (`DialogBrandAccent` in `packages/ui/src/components/dialog.tsx`) — never re-add it manually inside a dialog; opt out with `brandAccent={false}` only for palette-style surfaces (e.g. `CommandDialog`).
- Item-detail header: radial `primary-deep` glow behind the title (6% light / 9% dark) + purple halo shadow on the icon tile.
- Selection tint + indicator bars (above).

Do not add new ambient purple without explicit user sign-off.

## Identity visuals

- **Deterministic gradients**: vault tiles, favicon fallbacks, and account avatars use `linear-gradient(135deg, mid, deep)` from a name-hashed 17-color palette (hash: `charCodeAt + ((hash << 5) - hash)`). Vaults/favicons: palette in `packages/ui/src/lib/favicon-luminance.ts` and `vault-avatar.tsx`. Accounts: always the purple `from-primary to-primary-deep` gradient. All gradient tiles get `shadow-[inset_0_0_0_1px_oklch(1_0_0/0.12)]` instead of a border; glyphs/initials are white.
- **Account initials**: teamName → name → email, first letters of up-to-two words (see `getAccountInitials` in `packages/ui/src/components/account-switcher.tsx`). Never slice raw email (produces "j." artifacts).
- **Tags**: a 7px round color dot (`getTagColorFromName`) — in the sidebar the dot *replaces* the icon; in badges it sits inside a neutral chip. Tag chips are never fully colored.
- **Favicons**: served via the server's `/favicon/{domain}` proxy (CORS `*`). Dark-icon legibility: `packages/ui/src/lib/favicon-luminance.ts` canvas-samples each favicon once per session; "dark" icons get a `dark:bg-white/90` tile. Detection degrades to no-op when pixels aren't readable — never let it break image loading (the displayed `<img>` must not set `crossOrigin`).

## Layout constants (desktop)

- Sidebar `w-54` (216px); nav rows `h-7 px-2 gap-2 rounded-sm text-sm`.
- Top header `h-12` (contains search + New Item; keep `data-tauri-drag-region` on spacers).
- Item-list controls bar and item-detail top bar: both `h-9` — keep them equal.
- List rows `px-2.5 py-2 gap-2.5 rounded-sm`; icon buttons in bars are `size-7`.
- Detail view: field-row groups as `bg-card rounded-lg border` cards with hairline internal dividers, 46px hover rows with hover-revealed `size-7` actions (see `packages/ui/src/components/vault/item-detail/field-components.tsx`).

## Motion

Light touch: 100–150ms ease transitions on background/color/opacity; popovers ~130ms with slight scale/translate; hover-revealed actions fade via `opacity-0 group-hover:opacity-100`. No springy or attention-seeking animation.

## Process rules for agents

1. **Read before you restyle**: match an existing recipe from this file or a neighboring component before writing new classes.
2. **Mockup is the referee**: when a treatment is ambiguous, check `docs/design-explorations/3-brand-forward.html`.
3. **Both themes, always**: any hardcoded color needs a light-mode story. Prefer tokens; if you must use an arbitrary value, add the `dark:` variant deliberately.
4. **i18n is strict**: no hardcoded user-facing strings — add to every `packages/i18n/messages/*.json`, then `pnpm i18n:generate`.
5. **Verification**: `pnpm run check-types` and `npx biome check .` must pass. Never run dev servers (one is already running) or build commands. Note `biome.json` excludes `packages/ui/src/components` — don't rely on Biome to format there; still match repo style.
6. **Accessibility**: decorative divs (glows, washes, dots) get `aria-hidden`; hover-revealed controls need `focus-visible:opacity-100`.

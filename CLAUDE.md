## Must Follow Guidelines

- For user-facing UI, follow the design system spec in `DESIGN.md` (tokens, elevation ladder, selection/hover/button recipes).
- Name concepts with the vocabulary in `CONTEXT.md`, in code and in UI copy alike. Settled architectural decisions are recorded in `docs/adr/` — read the relevant one before proposing a change that contradicts it.
- Verify changes with `pnpm check-types` and `pnpm test` (`pnpm test:server` for Rust).
- Never hand-fix formatting or class sorting — run `pnpm biome check --write <changed files>` instead. Don't run `pnpm check:fix`; it applies `--unsafe` fixes repo-wide.
- Never run the dev server (one is always running) and never run a build command unless explicitly asked.
- Database migrations live in `apps/server/migrations`. Create with `pnpm run db:create -- <name>`, apply with `pnpm run db:migrate`. Never generate migrations from an ORM schema.
- Avoid `useEffect` — find a way without it first, and refactor existing ones away when you touch them.
- Strict i18n: never hardcode user-facing text. Add new keys to every `packages/i18n/messages/*.json`, then run `pnpm i18n:generate`.
- For a critical bug, write a failing automated test first, then fix it.
- Follow [RELEASING.md](RELEASING.md) for version changes and releases. Do not edit release versions or create release tags by hand.
- Comments: explain **why**, never **what**. Max 1-2 lines, only for non-obvious constraints, workarounds, or security rules. If a comment restates the code, delete it and pick a better name. No comment blocks, no commented-out code, and no changelog ("was X, now Y") — describe the code as it stands. Constraints that still bind (back-compat shims, version pins, old data shapes) are a why, so keep those.

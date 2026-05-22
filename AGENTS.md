# Agents.md

This file provides guidance to agents when working with code in this repository.

## Must Follow Guidelines

- Ignore any class sorting issues, it will be auto formatted by Biome.
- Ignore any weird formatting issues, it will be auto formatted by Biome.
- Never run the dev server to test code changes, a dev server is always running when working with this repository.
- Don't run any build command unless explicitly asked to do so.
- The application is not live yet, we can make any changes we want to the codebase without worrying about breaking anything, in the worst case i delete my local database.
- Database migrations live in `apps/server/migrations`. Create new migrations with `pnpm run db:create -- <name>` and apply them with `pnpm run db:migrate`. Do not use Drizzle schema generation for migrations.
- In React, try to not use useEffect unless you have to, we want to keep our components as simple as possible, if you find yourself needing to use useEffect, try to find a way to do it without it first.
- If you notice a useEffect that can be refactored to not use useEffect, please do so!
- We enforce strict i18n, never hardcode any user facing text, if you need to add a new text, add it to every language .json file inside `packages/i18n/messages/*.json`.
- After making changes to the translation files make sure to run `pnpm i18n:generate` to regenerate the paraglide files.
- If you need to fix a critical bug, always try to write an automated test for it if possible first & fix the bug after, this way we can ensure the bug is fixed and doesn't regress in the future.
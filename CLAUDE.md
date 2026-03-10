# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Must Follow Guidelines

- Ignore any class sorting issues, it will be auto formatted by Biome.
- Ignore any weird formatting issues, it will be auto formatted by Biome.
- Never run the dev server to test code changes, a dev server is always running when working with this repository.
- Don't run any build command unless explicitly asked to do so.
- The application is not live yet, we can make any changes we want to the codebase without worrying about breaking anything, in the worst case i delete my local database.
- Never create database migrations manually, edit the schema and run db:generate, you can edit the generated migration file if you need to make adjustments, but never create one from scratch.
- In React, try to not use useEffect unless you have to, we want to keep our components as simple as possible, if you find yourself needing to use useEffect, try to find a way to do it without it first.
- If you notice a useEffect that can be refactored to not use useEffect, please do so!
- We enforce strict i18n, never hardcode any user facing text, if you need to add a new text, add it under `packages/i18n/messages/en.json`.
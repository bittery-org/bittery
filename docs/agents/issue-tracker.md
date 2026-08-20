# Issue tracker: repository Markdown

Issues, Wayfinder maps, specs, and implementation tickets for this repository live as committed
Markdown files in `planning/`. They are not mirrored to the repository's GitHub Issues.

## Conventions

- One effort per directory: `planning/<effort-slug>/`.
- A Wayfinder map is `planning/<effort-slug>/map.md`.
- A spec is `planning/<feature-slug>/spec.md`.
- Tickets are one file each at `planning/<effort-slug>/issues/<NN>-<slug>.md`, numbered from `01`
  in dependency order.
- `Type:` records `research`, `prototype`, `grilling`, or `task` for Wayfinder decision tickets.
- `Status:` records the local triage or Wayfinder state.
- Comments and conversation history append under `## Comments`.

## Publishing

When a skill says to publish to the issue tracker, create or update the corresponding Markdown file
under `planning/`. No GitHub issue, label, comment, sub-issue, or blocking relation is created.

When a skill says to fetch a map, spec, or ticket, read the complete referenced local file, including
its comments.

## Wayfinding operations

- **Map:** `planning/<effort>/map.md` contains Destination, Notes, Decisions so far, Not yet
  specified, and Out of scope.
- **Child ticket:** `planning/<effort>/issues/<NN>-<slug>.md` contains one decision question.
- **Blocking:** `Blocked by: NN, NN` lists prerequisite tickets.
- **Frontier:** open, unblocked, unclaimed tickets; lowest number wins.
- **Claim:** set `Status: claimed` before starting work.
- **Resolve:** append the answer under `## Answer`, set `Status: resolved`, then add one linked gist
  to the map's Decisions so far.

Create ticket files before wiring their blocking numbers. Material that cannot yet be phrased as a
precise decision remains in the map's Not yet specified section.

## Visibility and durability

`planning/` is committed and shares this repository's public visibility. Commit tracker changes with
the work they describe so the decision record survives in Git history. Never place secrets,
credentials, personal data, or unpublished vulnerability detail in a ticket.

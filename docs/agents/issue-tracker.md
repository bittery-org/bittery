# Issue tracker: Local Markdown

Issues, Wayfinder maps, specs, and implementation tickets for this repository live as private
Markdown files in `.scratch/`. They are not published to the repository's GitHub Issues.

## Conventions

- One effort per directory: `.scratch/<effort-slug>/`.
- A Wayfinder map is `.scratch/<effort-slug>/map.md`.
- A spec is `.scratch/<feature-slug>/spec.md`.
- Tickets are one file each at `.scratch/<effort-slug>/issues/<NN>-<slug>.md`, numbered from `01`
  in dependency order.
- `Type:` records `research`, `prototype`, `grilling`, or `task` for Wayfinder decision tickets.
- `Status:` records the local triage or Wayfinder state.
- Comments and conversation history append under `## Comments`.

## Publishing

When a skill says to publish to the issue tracker, create or update the corresponding Markdown file
under `.scratch/`. No GitHub issue, label, comment, sub-issue, or blocking relation is created.

When a skill says to fetch a map, spec, or ticket, read the complete referenced local file, including
its comments.

## Wayfinding operations

- **Map:** `.scratch/<effort>/map.md` contains Destination, Notes, Decisions so far, Not yet
  specified, and Out of scope.
- **Child ticket:** `.scratch/<effort>/issues/<NN>-<slug>.md` contains one decision question.
- **Blocking:** `Blocked by: NN, NN` lists prerequisite tickets.
- **Frontier:** open, unblocked, unclaimed tickets; lowest number wins.
- **Claim:** set `Status: claimed` before starting work.
- **Resolve:** append the answer under `## Answer`, set `Status: resolved`, then add one linked gist
  to the map's Decisions so far.

Create ticket files before wiring their blocking numbers. Material that cannot yet be phrased as a
precise decision remains in the map's Not yet specified section.

## Privacy and durability

`.scratch/` is excluded through this repository's shared Git `info/exclude`; normal Git operations
must not publish it. Local exclusion also means the tracker is not backed up by the Bittery
repository. Back up long-running maps separately before relying on them as the only record of a
decision.

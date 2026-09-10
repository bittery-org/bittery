# Issue tracker: repository Markdown

Planning is version-controlled Markdown under `planning/`; it is not mirrored to GitHub Issues.

## Layout

- One effort per `planning/<effort>/`.
- A Wayfinder map is `planning/<effort>/map.md`.
- A specification is `planning/<effort>/spec.md` or a focused child directory's `spec.md`.
- Tickets are `planning/<effort>/issues/<NN>-<slug>.md`, numbered in dependency order.
- `Type:` is `research`, `prototype`, `grilling`, or `task`.
- `Status:` uses `claimed` and `resolved` for Wayfinder work, then `needs-triage`, `needs-info`,
  `ready-for-agent`, `ready-for-human`, or `wontfix` for delivery work.
- `Blocked by: NN, NN` names prerequisite tickets. Append durable discussion under `## Comments`.

## Wayfinder loop

1. Read the complete map and every linked prerequisite.
2. Choose the lowest-numbered open, unblocked, unclaimed ticket and set it to `claimed`.
3. Investigate or ask exactly the decision that ticket states.
4. Put the answer in the ticket, set it to `resolved`, and add one linked gist under the map's
   `Decisions so far`.
5. Turn a decision-complete vertical slice into a specification with observable acceptance criteria.
6. Create dependency-ordered task tickets. Mark a ticket `ready-for-agent` only when an agent can
   implement and verify it without inventing product or architecture decisions.

Material that cannot yet be phrased as one precise question remains under `Not yet specified` in the
map. Tracker files share the repository's public visibility; keep secrets and unpublished
vulnerability detail out of them.

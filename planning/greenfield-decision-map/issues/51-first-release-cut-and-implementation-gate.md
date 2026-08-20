# First-release cut and the implementation gate

Type: grilling
Status: ready-for-human
Blocked by: 05, 10, 14, 19, 21, 24, 25, 27, 28, 30, 32, 33, 34, 35, 36, 37, 42, 43, 45, 46, 47, 48, 49, 50

## Question

The terminal ticket. Everything else on the map closes first.

The platform set is already settled (Web, Desktop, Extension; Chromium and Firefox; mobile deferred with its seams designed). What is left is the detailed cut and the gate.

Decide:

- The final first-release feature list, with everything else explicitly assigned to a later cut.
- The build order in practice: Rust core, then server and sync, then clients, and what "done" means at each boundary.
- The per-slice implementation gate replacing the current all-or-nothing one, which as written forbids starting. See [corpus review, Worth a look #2](../research/corpus-review.md).
- What each slice must have accepted before implementation begins: its dispositions, formats, scenarios, and security decisions.
- The disposition table's outstanding rows and corrections, closed out.
- A final consistency review across every accepted decision on this map.

Produces: the release definition, the revised implementation gate in `docs/greenfield/README.md`, and the handoff to spec authoring.

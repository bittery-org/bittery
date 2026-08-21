# Browser durability floor prototype

Throwaway primary evidence for
[Browser durability floor](../../issues/16-browser-durability-floor.md). It is not product code.

Run from the repository root:

```sh
python3 -m http.server 4173 --directory planning/greenfield-decision-map/prototypes/browser-durability
```

Then open `http://localhost:4173/`.

The files are deliberately static and dependency-free. They are split because the target Content
Security Policy permits only same-origin scripts and Workers; a self-contained HTML file would need
an inline or `blob:` Worker and would test the wrong policy.

## What it can and cannot establish

The IndexedDB probe writes the Replica control row, local operation, encrypted object, and overlay in
one `readwrite` transaction with the `strict` durability hint. It can expose a partial transaction if
the browser makes one visible after Worker termination. It also demonstrates the indeterminate case
where commit succeeds but the Worker dies before acknowledging it.

The OPFS probe writes one file through a synchronous access handle. It shows observable behavior
around `flush()`, but it is not a SQLite adapter and does not establish transactional equivalence.

Neither probe can prove physical disk persistence, power-loss behavior, future retention of an
origin, or behavior in a browser engine in which it was not run. Repeated successful runs are not a
durability guarantee.

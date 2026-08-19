/**
 * One React root per container, however many times an entry module evaluates.
 *
 * `createRoot` twice on the same element leaves two roots owning the same nodes.
 * React warns, then the losing root throws `removeChild`/`insertBefore`
 * DOMExceptions as it tries to reconcile children the other one has already moved,
 * which surfaces inside whatever error boundary happens to be nearest.
 *
 * That double evaluation is a dev-mode fact of life here: crxjs serves the popup and
 * the overlay frames through an inline script that re-imports the entry with a fresh
 * `?t=`, and React Fast Refresh re-runs an entry it cannot treat as a refresh
 * boundary. Each evaluation is a distinct module instance, so module-level
 * bookkeeping would not see the earlier root — the container and the global symbol
 * registry are the only things the instances share.
 *
 * In production the entry evaluates once and this is inert.
 */

export const REACT_ROOT_KEY = Symbol.for("bittery.react-root");

type Rooted<Root> = Element & { [REACT_ROOT_KEY]?: Root };

export function getOrCreateRoot<Root>(
	container: Element,
	createRoot: (container: Element) => Root,
): Root {
	const rooted = container as Rooted<Root>;
	const existing = rooted[REACT_ROOT_KEY];
	if (existing !== undefined) {
		return existing;
	}

	const root = createRoot(container);
	rooted[REACT_ROOT_KEY] = root;
	return root;
}

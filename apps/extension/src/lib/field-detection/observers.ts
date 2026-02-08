/**
 * Enhanced mutation observer for dynamic form detection
 */
export function createEnhancedObserver(
	callback: (mutations: MutationRecord[]) => void,
	root: Document | ShadowRoot = document,
): MutationObserver {
	const observer = new MutationObserver((mutations) => {
		// Check if any mutations are relevant to form/input detection
		const relevantMutations = mutations.filter((mutation) => {
			// Check added nodes
			for (const node of mutation.addedNodes) {
				if (node instanceof HTMLElement) {
					if (
						node.tagName === "INPUT" ||
						node.tagName === "FORM" ||
						node.querySelector("input, form")
					) {
						return true;
					}
					// Check for shadow root additions
					if (node.shadowRoot) {
						return true;
					}
				}
			}

			// Check attribute changes on inputs
			if (
				mutation.type === "attributes" &&
				mutation.target instanceof HTMLInputElement
			) {
				const relevantAttrs = ["type", "name", "id", "autocomplete", "hidden"];
				if (
					mutation.attributeName &&
					relevantAttrs.includes(mutation.attributeName)
				) {
					return true;
				}
			}

			return false;
		});

		if (relevantMutations.length > 0) {
			callback(relevantMutations);
		}
	});

	// Observe the root with comprehensive settings
	const targetNode = root === document ? document.body : root;
	observer.observe(targetNode, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["type", "name", "id", "autocomplete", "hidden", "style"],
	});

	return observer;
}

/**
 * Watch for shadow roots being attached to elements
 */
export function observeShadowRoots(
	callback: (shadowRoot: ShadowRoot, host: Element) => void,
): void {
	// Store original attachShadow
	const originalAttachShadow = Element.prototype.attachShadow;

	// Override attachShadow to detect new shadow roots
	Element.prototype.attachShadow = function (init: ShadowRootInit): ShadowRoot {
		const shadowRoot = originalAttachShadow.call(this, init);

		// Notify about new shadow root after a small delay to allow initialization
		setTimeout(() => {
			callback(shadowRoot, this);
		}, 0);

		return shadowRoot;
	};
}

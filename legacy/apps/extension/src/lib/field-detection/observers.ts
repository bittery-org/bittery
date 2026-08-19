/** Attributes that can change whether an input is autofillable. */
const RELEVANT_ATTRIBUTES: string[] = [
	"type",
	"name",
	"id",
	"autocomplete",
	"hidden",
];

/**
 * Enhanced mutation observer for dynamic form detection
 */
export function createEnhancedObserver(
	callback: (mutations: MutationRecord[]) => void,
	root: Document | ShadowRoot = document,
): MutationObserver {
	const observer = new MutationObserver((mutations) => {
		// `some`, not `filter`: the callback only needs to know *whether* anything
		// relevant happened, and the check below runs `querySelector` over every
		// added subtree. On a busy SPA that is the difference between one subtree
		// query and hundreds per mutation batch.
		const isRelevant = mutations.some((mutation) => {
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
				return RELEVANT_ATTRIBUTES.includes(mutation.attributeName ?? "");
			}

			return false;
		});

		if (isRelevant) {
			callback(mutations);
		}
	});

	// Observe the root with comprehensive settings.
	//
	// `style` is deliberately absent from the filter: nothing above treats it as
	// relevant, but inline style writes are among the most common mutations on
	// the web (animations, JS layout, ad scripts). Observing them woke this
	// callback — and re-ran the whole subtree check — thousands of times per page
	// for a result that was always "not relevant".
	const targetNode = root === document ? document.body : root;
	observer.observe(targetNode, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: RELEVANT_ATTRIBUTES,
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

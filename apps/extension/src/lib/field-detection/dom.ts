/**
 * Get all inputs including those in Shadow DOM
 */
export function getAllInputs(root: Document | ShadowRoot = document): {
	input: HTMLInputElement;
	shadowRoot?: ShadowRoot;
}[] {
	const results: { input: HTMLInputElement; shadowRoot?: ShadowRoot }[] = [];

	// Get inputs from current context
	const inputs = root.querySelectorAll<HTMLInputElement>("input");
	for (const input of inputs) {
		results.push({
			input,
			shadowRoot: root instanceof ShadowRoot ? root : undefined,
		});
	}

	// Recursively search Shadow DOMs
	const elementsWithShadow = root.querySelectorAll("*");
	for (const element of elementsWithShadow) {
		if (element.shadowRoot) {
			const shadowInputs = getAllInputs(element.shadowRoot);
			results.push(
				...shadowInputs.map((si) => ({
					input: si.input,
					// biome-ignore lint/style/noNonNullAssertion: Its okay here
					shadowRoot: si.shadowRoot || element.shadowRoot!,
				})),
			);
		}
	}

	return results;
}

/**
 * Find associated label for an input element
 */
export function findLabel(
	input: HTMLInputElement,
	root: Document | ShadowRoot = document,
): string {
	// Check for explicit label via for attribute
	if (input.id) {
		const label = root.querySelector(`label[for="${input.id}"]`);
		if (label?.textContent) {
			return label.textContent.trim();
		}
	}

	// Check for wrapping label
	const parentLabel = input.closest("label");
	if (parentLabel?.textContent) {
		return parentLabel.textContent.trim();
	}

	// Check for aria-labelledby
	const labelledBy = input.getAttribute("aria-labelledby");
	if (labelledBy) {
		const labelElement = root.getElementById(labelledBy);
		if (labelElement?.textContent) {
			return labelElement.textContent.trim();
		}
	}

	// Check for preceding sibling text
	const prevSibling = input.previousElementSibling;
	if (
		prevSibling &&
		(prevSibling.tagName === "LABEL" || prevSibling.tagName === "SPAN")
	) {
		return prevSibling.textContent?.trim() || "";
	}

	// Check parent for label-like text
	const parent = input.parentElement;
	if (parent) {
		const labelChild = parent.querySelector("label, .label, .form-label");
		if (labelChild?.textContent) {
			return labelChild.textContent.trim();
		}
	}

	return "";
}

/**
 * Get visible fields only
 */
export function isFieldVisible(input: HTMLInputElement): boolean {
	// Check if element is in the DOM
	if (!input.isConnected) {
		return false;
	}

	// Check computed style
	const style = window.getComputedStyle(input);
	if (
		style.display === "none" ||
		style.visibility === "hidden" ||
		style.opacity === "0"
	) {
		return false;
	}

	// Check dimensions
	const rect = input.getBoundingClientRect();
	if (rect.width === 0 || rect.height === 0) {
		return false;
	}

	// Check if any ancestor is hidden
	let parent = input.parentElement;
	while (parent) {
		const parentStyle = window.getComputedStyle(parent);
		if (parentStyle.display === "none" || parentStyle.visibility === "hidden") {
			return false;
		}
		parent = parent.parentElement;
	}

	return true;
}

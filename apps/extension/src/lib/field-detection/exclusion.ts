/**
 * Check if an input should be excluded from autofill detection
 */
export function shouldExcludeField(input: HTMLInputElement): boolean {
	// Exclude fields with specific roles
	const role = input.getAttribute("role");
	if (role && ["search", "searchbox", "combobox"].includes(role)) {
		return true;
	}

	// Exclude fields with search-related attributes
	const type = input.type?.toLowerCase() || "text";
	if (type === "search") {
		return true;
	}

	// Check for search/filter/query patterns in various attributes
	const name = input.name?.toLowerCase() || "";
	const id = input.id?.toLowerCase() || "";
	const placeholder = input.placeholder?.toLowerCase() || "";
	const ariaLabel = input.getAttribute("aria-label")?.toLowerCase() || "";
	const className = input.className?.toLowerCase() || "";

	// Common search/filter/query patterns that should be excluded
	const excludePatterns = [
		/\bsearch\b/i,
		/\bquery\b/i,
		/\bfilter\b/i,
		/\bfind\b/i,
		/\blookup\b/i,
		/\bq\b/i,
		/^s$/i,
		/\bkeyword/i,
		/\bchat\b/i,
		/\bmessage\b/i,
		/\bcomment\b/i,
		/\breply\b/i,
		/\bsubject\b/i,
		/\btitle\b(?!.*card)/i,
		/\bdescription\b/i,
		/\bnote\b/i,
		/\bamount\b/i,
		/\bprice\b/i,
		/\bquantity\b/i,
		/\bqty\b/i,
		/\bcoupon\b/i,
		/\bpromo.*code\b(?!.*password)/i,
		/\btracking\b/i,
		/\burl\b/i,
		/\blink\b/i,
		/\btag\b/i,
		/\bcategory\b/i,
	];

	const textToCheck = [name, id, placeholder, ariaLabel, className].join(" ");
	if (excludePatterns.some((pattern) => pattern.test(textToCheck))) {
		return true;
	}

	// Exclude inputs that have autocomplete="off" AND are search-like
	const autocomplete = input.autocomplete?.toLowerCase();
	if (
		autocomplete === "off" &&
		(textToCheck.includes("search") || textToCheck.includes("filter"))
	) {
		return true;
	}

	// Exclude inputs in search forms
	const form = input.closest("form");
	if (form) {
		const formRole = form.getAttribute("role");
		if (formRole === "search") {
			return true;
		}

		const formAction = form.action?.toLowerCase() || "";
		const formClass = form.className?.toLowerCase() || "";
		const formId = form.id?.toLowerCase() || "";

		if (
			/search/i.test(formAction) ||
			/search/i.test(formClass) ||
			/search/i.test(formId)
		) {
			return true;
		}
	}

	// Exclude contenteditable elements
	if (input.contentEditable === "true") {
		return true;
	}

	// Exclude read-only fields
	if (input.readOnly) {
		return true;
	}

	// Exclude disabled fields
	if (input.disabled) {
		return true;
	}

	return false;
}

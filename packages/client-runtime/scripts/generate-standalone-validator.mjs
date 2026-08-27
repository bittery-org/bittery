import standaloneCode from "ajv/dist/standalone/index.js";

export function generateStandaloneValidator(ajv, exports) {
	const validator = standaloneCode(ajv, exports).replace(
		/const (func\d+) = require\("ajv\/dist\/runtime\/ucs2length"\)\.default;/g,
		"const $1 = (value) => Array.from(value).length;",
	);

	if (validator.includes("require(")) {
		throw new Error(
			"Generated standalone validator contains a CommonJS runtime dependency",
		);
	}

	return validator;
}

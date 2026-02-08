import { isFieldVisible } from "./dom";
import { isCreditCardFieldType, isIdentityFieldType } from "./detectors";
import { detectMultiStepForm } from "./form-heuristics";
import type {
	DetectedCreditCardForm,
	DetectedField,
	DetectedIdentityForm,
	FormContext,
} from "./types";

/**
 * Group credit card fields into forms
 */
export function groupCreditCardFieldsByForm(
	fields: DetectedField[],
): DetectedCreditCardForm[] {
	const formMap = new Map<HTMLFormElement | null, DetectedCreditCardForm>();

	for (const field of fields) {
		if (!isCreditCardFieldType(field.type)) continue;

		const form = field.form || null;
		let formGroup = formMap.get(form);

		if (!formGroup) {
			formGroup = {
				form: form || undefined,
				shadowRoot: field.shadowRoot,
			};
			formMap.set(form, formGroup);
		}

		// Assign field to appropriate slot based on type
		switch (field.type) {
			case "cardNumber":
				if (
					!formGroup.cardNumberField ||
					field.confidence > formGroup.cardNumberField.confidence
				) {
					formGroup.cardNumberField = field;
				}
				break;
			case "cardExpiry":
				if (
					!formGroup.expiryField ||
					field.confidence > formGroup.expiryField.confidence
				) {
					formGroup.expiryField = field;
				}
				break;
			case "cardCvv":
				if (
					!formGroup.cvvField ||
					field.confidence > formGroup.cvvField.confidence
				) {
					formGroup.cvvField = field;
				}
				break;
			case "cardName":
				if (
					!formGroup.nameField ||
					field.confidence > formGroup.nameField.confidence
				) {
					formGroup.nameField = field;
				}
				break;
		}
	}

	// Return only forms that have at least a card number field
	return Array.from(formMap.values()).filter((form) => form.cardNumberField);
}

/**
 * Group identity fields by form
 */
export function groupIdentityFieldsByForm(
	fields: DetectedField[],
): DetectedIdentityForm[] {
	const formMap = new Map<HTMLFormElement | null, DetectedIdentityForm>();

	for (const field of fields) {
		if (!isIdentityFieldType(field.type)) continue;

		const form = field.form || null;
		let formGroup = formMap.get(form);

		if (!formGroup) {
			formGroup = {
				form: form || undefined,
				shadowRoot: field.shadowRoot,
			};
			formMap.set(form, formGroup);
		}

		// Assign field to appropriate slot based on type
		switch (field.type) {
			case "firstName":
				if (
					!formGroup.firstNameField ||
					field.confidence > formGroup.firstNameField.confidence
				) {
					formGroup.firstNameField = field;
				}
				break;
			case "lastName":
				if (
					!formGroup.lastNameField ||
					field.confidence > formGroup.lastNameField.confidence
				) {
					formGroup.lastNameField = field;
				}
				break;
			case "email":
				if (
					!formGroup.emailField ||
					field.confidence > formGroup.emailField.confidence
				) {
					formGroup.emailField = field;
				}
				break;
			case "phone":
				if (
					!formGroup.phoneField ||
					field.confidence > formGroup.phoneField.confidence
				) {
					formGroup.phoneField = field;
				}
				break;
			case "street":
				if (
					!formGroup.streetField ||
					field.confidence > formGroup.streetField.confidence
				) {
					formGroup.streetField = field;
				}
				break;
			case "city":
				if (
					!formGroup.cityField ||
					field.confidence > formGroup.cityField.confidence
				) {
					formGroup.cityField = field;
				}
				break;
			case "state":
				if (
					!formGroup.stateField ||
					field.confidence > formGroup.stateField.confidence
				) {
					formGroup.stateField = field;
				}
				break;
			case "postalCode":
				if (
					!formGroup.postalCodeField ||
					field.confidence > formGroup.postalCodeField.confidence
				) {
					formGroup.postalCodeField = field;
				}
				break;
			case "country":
				if (
					!formGroup.countryField ||
					field.confidence > formGroup.countryField.confidence
				) {
					formGroup.countryField = field;
				}
				break;
			case "dateOfBirth":
				if (
					!formGroup.dateOfBirthField ||
					field.confidence > formGroup.dateOfBirthField.confidence
				) {
					formGroup.dateOfBirthField = field;
				}
				break;
		}
	}

	// Return forms that have at least one identity field (not just firstName/lastName, but also address fields)
	return Array.from(formMap.values()).filter(
		(form) =>
			form.streetField ||
			form.cityField ||
			form.stateField ||
			form.postalCodeField ||
			form.countryField ||
			(form.firstNameField && form.lastNameField),
	);
}

/**
 * Group fields by form context
 */
export function groupFieldsByForm(
	fields: DetectedField[],
): Map<HTMLFormElement | null, FormContext> {
	const formContexts = new Map<HTMLFormElement | null, FormContext>();

	for (const field of fields) {
		const form = field.form || null;
		let context = formContexts.get(form);

		if (!context) {
			const multiStepInfo = form
				? detectMultiStepForm(form)
				: { isMultiStep: false, currentStep: 1, totalSteps: 1 };

			context = {
				form: form || undefined,
				fields: [],
				isMultiStep: multiStepInfo.isMultiStep,
				currentStep: multiStepInfo.currentStep,
				totalSteps: multiStepInfo.totalSteps,
				shadowRoot: field.shadowRoot,
			};
			formContexts.set(form, context);
		}

		context.fields.push(field);
	}

	return formContexts;
}

/**
 * Find the best username/email and password pair in a form
 */
export function findCredentialPair(fields: DetectedField[]): {
	usernameField?: DetectedField;
	passwordField?: DetectedField;
} {
	let usernameField: DetectedField | undefined;
	let passwordField: DetectedField | undefined;

	// Find best password field
	const passwordFields = fields.filter((f) => f.type === "password");
	if (passwordFields.length > 0) {
		// Prefer visible password fields
		passwordField =
			passwordFields.find((f) => isFieldVisible(f.element)) || passwordFields[0];
	}

	// Find best username/email field
	const usernameFields = fields.filter(
		(f) => f.type === "username" || f.type === "email",
	);
	if (usernameFields.length > 0) {
		// Prefer visible fields with higher confidence
		const visibleUserFields = usernameFields.filter((f) => isFieldVisible(f.element));
		if (visibleUserFields.length > 0) {
			// Sort by confidence and take the best
			visibleUserFields.sort((a, b) => b.confidence - a.confidence);
			usernameField = visibleUserFields[0];
		} else {
			usernameFields.sort((a, b) => b.confidence - a.confidence);
			usernameField = usernameFields[0];
		}
	}

	return { usernameField, passwordField };
}

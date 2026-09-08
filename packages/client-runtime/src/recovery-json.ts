import type { RecoveryBound } from "../generated/runtime-protocol/contract";
import { RecoveryLimitError } from "./recovery-limit";
export const RECOVERY_RECORD_BYTES = 64 * 1024 * 1024;
export const RECOVERY_CONTROL_BYTES = RECOVERY_RECORD_BYTES + 64 * 1024;

/** Validates exact UTF-8 without allocating a second potentially 64-MiB row. */
export function assertRecoveryTextBound(
	text: string,
	limit = RECOVERY_RECORD_BYTES,
	bound: RecoveryBound = "recordBytes",
): void {
	stringBytes(text, limit, false, bound);
}
function stringBytes(
	text: string,
	limit: number,
	quoted: boolean,
	bound: RecoveryBound,
): number {
	let bytes = quoted ? 2 : 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (
			quoted &&
			(code === 34 ||
				code === 92 ||
				code === 8 ||
				code === 9 ||
				code === 10 ||
				code === 12 ||
				code === 13)
		)
			bytes += 2;
		else if (quoted && code < 32) bytes += 6;
		else if (code < 0x80) bytes++;
		else if (code < 0x800) bytes += 2;
		else if (
			code >= 0xd800 &&
			code <= 0xdbff &&
			index + 1 < text.length &&
			text.charCodeAt(index + 1) >= 0xdc00 &&
			text.charCodeAt(index + 1) <= 0xdfff
		) {
			bytes += 4;
			index++;
		} else if (code >= 0xd800 && code <= 0xdfff)
			throw new Error("Recovery record contains unpaired UTF-16 surrogates");
		else bytes += 3;
		if (bytes > limit) throw new RecoveryLimitError(bound);
	}
	if (bytes > limit) throw new RecoveryLimitError(bound);
	return bytes;
}

/** Count JSON escaping before serialization; physical records contain only plain data. */
export function assertRecoveryJsonBound(
	value: unknown,
	limit = RECOVERY_CONTROL_BYTES,
	bound: RecoveryBound = "controlBytes",
): void {
	let remaining = limit;
	const ancestors = new Set<object>();
	const take = (bytes: number) => {
		remaining -= bytes;
		if (remaining < 0) throw new RecoveryLimitError(bound);
	};
	const visit = (item: unknown, depth: number): void => {
		if (depth > 64) throw new Error("Recovery metadata nesting is invalid");
		if (item === null) {
			take(4);
			return;
		}
		if (typeof item === "string") {
			take(stringBytes(item, remaining, true, bound));
			return;
		}
		if (typeof item === "boolean") {
			take(item ? 4 : 5);
			return;
		}
		if (typeof item === "number") {
			take(Number.isFinite(item) ? String(item).length : 4);
			return;
		}
		if (typeof item !== "object" || ancestors.has(item))
			throw new Error("Recovery metadata is not plain JSON data");
		const array = Array.isArray(item);
		if (
			!array &&
			Object.getPrototypeOf(item) !== Object.prototype &&
			Object.getPrototypeOf(item) !== null
		)
			throw new Error("Recovery metadata is not plain JSON data");
		ancestors.add(item);
		take(2);
		if (array) {
			for (let i = 0; i < item.length; i++) {
				if (i > 0) take(1);
				visit(item[i] === undefined ? null : item[i], depth + 1);
			}
		} else {
			let count = 0;
			for (const key of Object.keys(item)) {
				const descriptor = Object.getOwnPropertyDescriptor(item, key);
				if (descriptor === undefined || !("value" in descriptor))
					throw new Error("Recovery metadata accessor is invalid");
				if (descriptor.value === undefined) continue;
				if (count++ > 0) take(1);
				take(stringBytes(key, remaining, true, bound));
				take(1);
				visit(descriptor.value, depth + 1);
			}
		}
		ancestors.delete(item);
	};
	visit(value, 0);
}
export function recoveryJson(
	value: unknown,
	limit = RECOVERY_CONTROL_BYTES,
	bound: RecoveryBound = "controlBytes",
): string {
	assertRecoveryJsonBound(value, limit, bound);
	return JSON.stringify(value);
}

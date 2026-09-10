const Uint8ArrayIntrinsic = Uint8Array;
const Uint8ArrayFill = Uint8Array.prototype.fill;
const Uint8ArraySet = Uint8Array.prototype.set;
const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const TypedArrayBuffer = Object.getOwnPropertyDescriptor(
	TypedArrayPrototype,
	"buffer",
)?.get;
const TypedArrayByteOffset = Object.getOwnPropertyDescriptor(
	TypedArrayPrototype,
	"byteOffset",
)?.get;
const TypedArrayByteLength = Object.getOwnPropertyDescriptor(
	TypedArrayPrototype,
	"byteLength",
)?.get;
const TypedArrayName = Object.getOwnPropertyDescriptor(
	TypedArrayPrototype,
	Symbol.toStringTag,
)?.get;
const ArrayBufferByteLength = Object.getOwnPropertyDescriptor(
	ArrayBuffer.prototype,
	"byteLength",
)?.get;
const DataViewBuffer = Object.getOwnPropertyDescriptor(
	DataView.prototype,
	"buffer",
)?.get;
const SharedArrayBufferByteLength =
	typeof SharedArrayBuffer === "undefined"
		? undefined
		: Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")
				?.get;

export interface Uint8ArrayIntrinsicView {
	readonly value: Uint8Array;
	readonly buffer: ArrayBufferLike;
	readonly arrayBuffer?: ArrayBuffer;
	readonly byteOffset: number;
	readonly byteLength: number;
	readonly hasOnlyIndexedOwnData: boolean;
}

function hasOnlyIndexedOwnData(value: object, byteLength: number): boolean {
	const keys = Reflect.ownKeys(value);
	if (keys.length !== byteLength) return false;
	return keys.every((key) => {
		if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) return false;
		const index = Number(key);
		if (!Number.isSafeInteger(index) || index >= byteLength) return false;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor?.get === undefined && descriptor?.set === undefined;
	});
}

/** Read Uint8Array internal slots without consulting any instance property. */
export function inspectUint8ArrayIntrinsic(
	value: unknown,
): Uint8ArrayIntrinsicView | undefined {
	if (
		typeof value !== "object" ||
		value === null ||
		TypedArrayBuffer === undefined ||
		TypedArrayByteOffset === undefined ||
		TypedArrayByteLength === undefined ||
		TypedArrayName === undefined ||
		ArrayBufferByteLength === undefined
	)
		return undefined;
	try {
		if (TypedArrayName.call(value) !== "Uint8Array") return undefined;
		const buffer = TypedArrayBuffer.call(value) as unknown;
		let arrayBuffer: ArrayBuffer | undefined;
		try {
			ArrayBufferByteLength.call(buffer);
			arrayBuffer = buffer as ArrayBuffer;
		} catch {
			if (SharedArrayBufferByteLength === undefined) return undefined;
			SharedArrayBufferByteLength.call(buffer);
		}
		const byteOffset = TypedArrayByteOffset.call(value) as number;
		const byteLength = TypedArrayByteLength.call(value) as number;
		return {
			value: value as Uint8Array,
			buffer: buffer as ArrayBufferLike,
			arrayBuffer,
			byteOffset,
			byteLength,
			hasOnlyIndexedOwnData: hasOnlyIndexedOwnData(value, byteLength),
		};
	} catch {
		return undefined;
	}
}

export function isFullOwnedUint8Array(view: Uint8ArrayIntrinsicView): boolean {
	try {
		return (
			view.arrayBuffer !== undefined &&
			view.byteOffset === 0 &&
			view.byteLength === ArrayBufferByteLength?.call(view.arrayBuffer)
		);
	} catch {
		return false;
	}
}

/** Copy through typed-array internal slots; no iterator, index, or metadata getter is read. */
export function copyUint8ArrayIntrinsic(
	view: Uint8ArrayIntrinsicView,
): Uint8Array {
	const copy = new Uint8ArrayIntrinsic(view.byteLength);
	Uint8ArraySet.call(copy, view.value);
	return copy;
}

/**
 * Validate, copy, and wipe a source-owned full ArrayBuffer view as one synchronous operation.
 * The returned view is newly owned; every source path is wiped without consulting instance
 * metadata, iteration, or indexed properties.
 */
export function takeFullOwnedUint8ArrayIntrinsic(
	value: unknown,
): ArrayBuffer | undefined {
	try {
		const view = inspectUint8ArrayIntrinsic(value);
		if (
			view === undefined ||
			view.byteLength === 0 ||
			!view.hasOnlyIndexedOwnData ||
			!isFullOwnedUint8Array(view)
		)
			return undefined;
		return TypedArrayBuffer?.call(copyUint8ArrayIntrinsic(view)) as ArrayBuffer;
	} catch {
		return undefined;
	} finally {
		wipeBinaryIntrinsic(value);
	}
}

/** Wipe the complete reachable backing store without reading instance properties. */
export function wipeBinaryIntrinsic(value: unknown): void {
	if (typeof value !== "object" || value === null) return;
	let buffer: unknown;
	try {
		buffer = TypedArrayBuffer?.call(value);
	} catch {
		try {
			buffer = DataViewBuffer?.call(value);
		} catch {
			buffer = value;
		}
	}
	try {
		if (ArrayBufferByteLength !== undefined) ArrayBufferByteLength.call(buffer);
		Uint8ArrayFill.call(new Uint8ArrayIntrinsic(buffer as ArrayBuffer), 0);
		return;
	} catch {
		// SharedArrayBuffer is deliberately wipeable but never transferable.
	}
	try {
		if (SharedArrayBufferByteLength === undefined) return;
		SharedArrayBufferByteLength.call(buffer);
		Uint8ArrayFill.call(
			new Uint8ArrayIntrinsic(buffer as SharedArrayBuffer),
			0,
		);
	} catch {}
}

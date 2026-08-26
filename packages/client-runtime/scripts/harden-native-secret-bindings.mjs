import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outputRoot = process.argv[2];
if (!outputRoot) throw new Error("native binding output root is required");

async function replaceExactly(file, needle, replacement) {
	const input = await readFile(file, "utf8");
	const occurrences = input.split(needle).length - 1;
	if (occurrences !== 1) {
		throw new Error(
			`${file}: expected one hardening seam, found ${occurrences}`,
		);
	}
	await writeFile(file, input.replace(needle, replacement));
}

const swift = path.join(outputRoot, "swift", "bittery_client_bindings.swift");
const header = path.join(outputRoot, "swift", "bittery_client_bindingsFFI.h");
const kotlin = path.join(
	outputRoot,
	"kotlin",
	"uniffi",
	"bittery_client_bindings",
	"bittery_client_bindings.kt",
);

await replaceExactly(
	header,
	"void ffi_bittery_client_bindings_rustbuffer_free(RustBuffer buf, RustCallStatus *_Nonnull out_status\n);\n#endif",
	"void ffi_bittery_client_bindings_rustbuffer_free(RustBuffer buf, RustCallStatus *_Nonnull out_status\n);\n#endif\n#ifndef BITTERY_CLIENT_BINDINGS_SENSITIVE_RUSTBUFFER_FREE\n#define BITTERY_CLIENT_BINDINGS_SENSITIVE_RUSTBUFFER_FREE\nvoid ffi_bittery_client_bindings_sensitive_rustbuffer_free(RustBuffer buf, RustCallStatus *_Nonnull out_status\n);\n#endif",
);

await replaceExactly(
	swift,
	"    func deallocate() {\n        try! rustCall { ffi_bittery_client_bindings_rustbuffer_free(self, $0) }\n    }",
	"    func deallocate() {\n        try! rustCall { ffi_bittery_client_bindings_rustbuffer_free(self, $0) }\n    }\n\n    // The returned Swift String is host-managed. This only wipes the Rust allocation after lift.\n    func deallocateSensitive() {\n        try! rustCall { ffi_bittery_client_bindings_sensitive_rustbuffer_free(self, $0) }\n    }",
);

await replaceExactly(
	swift,
	"\n\n\n\npublic protocol AttachmentProjectionProtocol",
	`\n\nfileprivate struct FfiConverterSensitiveString {
    public static func lift(_ value: RustBuffer) throws -> String {
        defer { value.deallocateSensitive() }
        if value.data == nil { return String() }
        let bytes = UnsafeBufferPointer<UInt8>(start: value.data!, count: Int(value.len))
        return String(decoding: bytes, as: UTF8.self)
    }
}\n\n\npublic protocol AttachmentProjectionProtocol`,
);

await replaceExactly(
	swift,
	"open func shareUrl() -> String  {\n    return try!  FfiConverterString.lift(try! rustCall() {",
	"open func shareUrl() -> String  {\n    return try!  FfiConverterSensitiveString.lift(try! rustCall() {",
);

await replaceExactly(
	kotlin,
	"        internal fun free(buf: RustBuffer.ByValue) = uniffiRustCall() { status ->\n            UniffiLib.ffi_bittery_client_bindings_rustbuffer_free(buf, status)\n        }",
	"        internal fun free(buf: RustBuffer.ByValue) = uniffiRustCall() { status ->\n            UniffiLib.ffi_bittery_client_bindings_rustbuffer_free(buf, status)\n        }\n\n        // The returned Kotlin String is host-managed. This only wipes the Rust allocation after lift.\n        internal fun freeSensitive(buf: RustBuffer.ByValue) = uniffiRustCall() { status ->\n            UniffiLib.ffi_bittery_client_bindings_sensitive_rustbuffer_free(buf, status)\n        }",
);

await replaceExactly(
	kotlin,
	"external fun ffi_bittery_client_bindings_rustbuffer_free(`buf`: RustBuffer.ByValue,uniffi_out_err: UniffiRustCallStatus, \n): Unit",
	"external fun ffi_bittery_client_bindings_rustbuffer_free(`buf`: RustBuffer.ByValue,uniffi_out_err: UniffiRustCallStatus, \n): Unit\nexternal fun ffi_bittery_client_bindings_sensitive_rustbuffer_free(`buf`: RustBuffer.ByValue,uniffi_out_err: UniffiRustCallStatus, \n): Unit",
);

await replaceExactly(
	kotlin,
	"    override fun write(value: String, buf: ByteBuffer) {\n        val byteBuf = toUtf8(value)\n        buf.putInt(byteBuf.limit())\n        buf.put(byteBuf)\n    }\n}\n\n\n// This template implements a class for working with a Rust struct via a handle",
	`    override fun write(value: String, buf: ByteBuffer) {
        val byteBuf = toUtf8(value)
        buf.putInt(byteBuf.limit())
        buf.put(byteBuf)
    }
}

private object FfiConverterSensitiveString {
    fun lift(value: RustBuffer.ByValue): String {
        val byteArr = ByteArray(value.len.toInt())
        try {
            value.asByteBuffer()!!.get(byteArr)
            return byteArr.toString(Charsets.UTF_8)
        } finally {
            byteArr.fill(0)
            RustBuffer.freeSensitive(value)
        }
    }
}\n\n// This template implements a class for working with a Rust struct via a handle`,
);

await replaceExactly(
	kotlin,
	"    override fun `shareUrl`(): kotlin.String {\n            return FfiConverterString.lift(",
	"    override fun `shareUrl`(): kotlin.String {\n            return FfiConverterSensitiveString.lift(",
);

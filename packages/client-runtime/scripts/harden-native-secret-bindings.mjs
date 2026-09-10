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

    fun lower(value: String): RustBuffer.ByValue {
        val bytes = FfiConverterString.toUtf8(value)
        var rbuf: RustBuffer.ByValue? = null
        try {
            val allocated = RustBuffer.alloc(bytes.limit().toULong())
            rbuf = allocated
            allocated.asByteBuffer()!!.put(bytes)
            return allocated
        } catch (error: Throwable) {
            rbuf?.let { RustBuffer.freeSensitive(it) }
            throw error
        } finally {
            bytes.clear()
            while (bytes.hasRemaining()) bytes.put(0)
        }
    }
}

// This template implements a class for working with a Rust struct via a handle`,
);

await replaceExactly(
	kotlin,
	"    override fun `shareUrl`(): kotlin.String {\n            return FfiConverterString.lift(",
	"    override fun `shareUrl`(): kotlin.String {\n            return FfiConverterSensitiveString.lift(",
);

await replaceExactly(
	swift,
	"fileprivate struct FfiConverterSensitiveString {\n    public static func lift(_ value: RustBuffer) throws -> String {\n        defer { value.deallocateSensitive() }\n        if value.data == nil { return String() }\n        let bytes = UnsafeBufferPointer<UInt8>(start: value.data!, count: Int(value.len))\n        return String(decoding: bytes, as: UTF8.self)\n    }\n}",
	`fileprivate struct FfiConverterSensitiveString {
    public static func lift(_ value: RustBuffer) throws -> String {
        defer { value.deallocateSensitive() }
        if value.data == nil { return String() }
        let bytes = UnsafeBufferPointer<UInt8>(start: value.data!, count: Int(value.len))
        return String(decoding: bytes, as: UTF8.self)
    }

    public static func lower(_ value: String) -> RustBuffer {
        var bytes = Array(value.utf8)
        defer {
            bytes.withUnsafeMutableBytes { raw in
                raw.initializeMemory(as: UInt8.self, repeating: 0)
            }
        }
        return RustBuffer(bytes: bytes)
    }
}`,
);

await replaceExactly(
	swift,
	"binaryChunkBase64: try FfiConverterTypeSensitiveVaultImageChunk_lift(binaryChunkBase64)",
	"binaryChunkBase64: try FfiConverterSensitiveString.lift(binaryChunkBase64)",
);
await replaceExactly(
	swift,
	"let writeReturn = { uniffiOutReturn.pointee = FfiConverterTypeSensitiveVaultImageChunk_lower($0) }",
	"let writeReturn = { uniffiOutReturn.pointee = FfiConverterSensitiveString.lower($0) }",
);
await replaceExactly(
	kotlin,
	"FfiConverterTypeSensitiveVaultImageChunk.lift(`binaryChunkBase64`)",
	"FfiConverterSensitiveString.lift(`binaryChunkBase64`)",
);
await replaceExactly(
	kotlin,
	"val writeReturn = { value: SensitiveVaultImageChunk -> uniffiOutReturn.setValue(FfiConverterTypeSensitiveVaultImageChunk.lower(value)) }",
	"val writeReturn = { value: SensitiveVaultImageChunk -> uniffiOutReturn.setValue(FfiConverterSensitiveString.lower(value)) }",
);

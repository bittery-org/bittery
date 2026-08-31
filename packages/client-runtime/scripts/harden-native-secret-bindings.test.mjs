import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const kotlin = await readFile(
	new URL(
		"../generated/native/kotlin/uniffi/bittery_client_bindings/bittery_client_bindings.kt",
		import.meta.url,
	),
	"utf8",
);
const swift = await readFile(
	new URL(
		"../generated/native/swift/bittery_client_bindings.swift",
		import.meta.url,
	),
	"utf8",
);

test("Kotlin Vault-image callbacks transfer sensitive payloads without a record buffer", () => {
	assert.equal(
		kotlin.match(/private object FfiConverterSensitiveString/g)?.length,
		1,
		"the generated Kotlin source must contain one compilable helper declaration",
	);
	const artifact = kotlin.slice(
		kotlin.indexOf(
			"internal object uniffiCallbackInterfaceVaultImageArtifactExecutor",
		),
		kotlin.indexOf("public object FfiConverterTypeVaultImageArtifactExecutor"),
	);
	const answer = kotlin.slice(
		kotlin.indexOf(
			"internal object uniffiCallbackInterfaceVaultImagePortAnswer",
		),
		kotlin.indexOf("public object FfiConverterTypeVaultImagePortAnswer"),
	);
	const source = kotlin.slice(
		kotlin.indexOf(
			"internal object uniffiCallbackInterfaceVaultImageSourceExecutor",
		),
		kotlin.indexOf("public object FfiConverterTypeVaultImageSourceExecutor"),
	);
	assert.match(
		artifact,
		/FfiConverterSensitiveString\.lift\(`binaryChunkBase64`\)/,
	);
	assert.match(answer, /FfiConverterSensitiveString\.lower\(value\)/);
	assert.match(source, /FfiConverterTypeVaultImagePortAnswer\.lower\(value\)/);
	assert.match(
		kotlin,
		/public interface VaultImagePortAnswer[\s\S]*takeBinaryChunkBase64/,
	);
	assert.match(
		kotlin,
		/FfiConverterTypeVaultImagePortAnswer: FfiConverter<VaultImagePortAnswer, Long>/,
	);
	assert.match(
		kotlin,
		/bytes\.clear\(\)[\s\S]*while \(bytes\.hasRemaining\(\)\) bytes\.put\(0\)/,
	);
	assert.doesNotMatch(artifact, /FfiConverterByteArray\.lift\(`binaryChunk/);
	assert.doesNotMatch(answer, /FfiConverterByteArray\.lower\(value\)/);
});

test("Swift Vault-image callbacks use object handles and wipe transferred String buffers", () => {
	const artifact = swift.slice(
		swift.indexOf(
			"fileprivate struct UniffiCallbackInterfaceVaultImageArtifactExecutor",
		),
		swift.indexOf("public struct FfiConverterTypeVaultImageArtifactExecutor"),
	);
	const answer = swift.slice(
		swift.indexOf(
			"fileprivate struct UniffiCallbackInterfaceVaultImagePortAnswer",
		),
		swift.indexOf("public struct FfiConverterTypeVaultImagePortAnswer"),
	);
	const source = swift.slice(
		swift.indexOf(
			"fileprivate struct UniffiCallbackInterfaceVaultImageSourceExecutor",
		),
		swift.indexOf("public struct FfiConverterTypeVaultImageSourceExecutor"),
	);
	assert.match(
		artifact,
		/FfiConverterSensitiveString\.lift\(binaryChunkBase64\)/,
	);
	assert.match(answer, /FfiConverterSensitiveString\.lower\(\$0\)/);
	assert.match(source, /FfiConverterTypeVaultImagePortAnswer_lower\(\$0\)/);
	assert.match(
		swift,
		/public protocol VaultImagePortAnswer[\s\S]*takeBinaryChunkBase64/,
	);
	assert.match(
		swift,
		/typealias FfiType = UInt64[\s\S]*typealias SwiftType = VaultImagePortAnswer/,
	);
	assert.match(
		swift,
		/var bytes = Array\(value\.utf8\)[\s\S]*initializeMemory\(as: UInt8\.self, repeating: 0\)/,
	);
	assert.doesNotMatch(artifact, /FfiConverterData\.lift\(binaryChunk/);
	assert.doesNotMatch(answer, /FfiConverterData\.lower\(\$0\)/);
});

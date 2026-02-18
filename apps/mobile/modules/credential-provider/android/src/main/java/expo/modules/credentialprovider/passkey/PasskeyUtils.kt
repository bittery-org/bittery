package expo.modules.credentialprovider.passkey

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject

data class StoredPasskey(
    val credentialId: String,
    val rpId: String,
    val rpName: String,
    val userHandle: String,
    val userName: String,
    val userDisplayName: String,
    val privateKey: String,
    val publicKey: String,
    val algorithm: Int = -7,
    val signCount: Int = 0,
    val transports: List<String> = listOf("internal", "hybrid"),
    val createdAt: String,
    val lastUsedAt: String? = null,
    val status: String? = null,
    val statusReason: String? = null,
    val statusUpdatedAt: String? = null
)

data class CreateRequestContext(
    val rpId: String,
    val rpName: String,
    val userHandle: String,
    val userName: String,
    val userDisplayName: String
)

object PasskeyUtils {

    fun normalizeHost(value: String?): String {
        if (value.isNullOrBlank()) return ""
        return value
            .trim()
            .lowercase()
            .removePrefix("https://")
            .removePrefix("http://")
            .substringBefore("/")
            .trimEnd('.')
    }

    fun parseRpIdFromGetRequestJson(requestJson: String): String? {
        val source = parseRequestSource(requestJson)
        return normalizeHost(source.optString("rpId")).takeIf { it.isNotEmpty() }
    }

    fun parseRpIdFromCreateRequestJson(requestJson: String): String? {
        val source = parseRequestSource(requestJson)
        val rpId = source.optJSONObject("rp")?.optString("id")
            ?: source.optString("rpId")
        return normalizeHost(rpId).takeIf { it.isNotEmpty() }
    }

    fun parseCreateRequestContext(requestJson: String): CreateRequestContext? {
        val source = parseRequestSource(requestJson)
        val rp = source.optJSONObject("rp") ?: return null
        val user = source.optJSONObject("user") ?: return null

        val rpId = normalizeHost(rp.optString("id")).takeIf { it.isNotEmpty() } ?: return null
        val rpName = rp.optString("name").takeIf { it.isNotBlank() } ?: rpId

        val rawUserHandle = user.optString("id")
        val userHandle = canonicalizeCredentialId(rawUserHandle).orEmpty()
        val userName = user.optString("name").orEmpty()
        val userDisplayName = user.optString("displayName").ifBlank { userName }

        if (userHandle.isBlank() || userName.isBlank()) {
            return null
        }

        return CreateRequestContext(
            rpId = rpId,
            rpName = rpName,
            userHandle = userHandle,
            userName = userName,
            userDisplayName = userDisplayName
        )
    }

    fun parseAllowCredentialIdsFromGetRequestJson(requestJson: String): Set<String> {
        val source = parseRequestSource(requestJson)
        val allow = source.optJSONArray("allowCredentials") ?: return emptySet()
        val ids = LinkedHashSet<String>(allow.length())
        for (index in 0 until allow.length()) {
            val descriptor = allow.optJSONObject(index) ?: continue
            canonicalizeCredentialIdValue(descriptor.opt("id"))?.let { ids.add(it) }
            canonicalizeCredentialIdValue(descriptor.opt("rawId"))?.let { ids.add(it) }
        }
        return ids
    }

    fun parseStoredPasskeys(itemDataJson: JSONObject): List<StoredPasskey> {
        val array = itemDataJson.optJSONArray("passkeys") ?: return emptyList()
        val passkeys = ArrayList<StoredPasskey>(array.length())
        for (index in 0 until array.length()) {
            val passkeyJson = array.optJSONObject(index) ?: continue
            val credentialId = canonicalizeCredentialIdValue(
                when {
                    passkeyJson.has("credentialId") -> passkeyJson.opt("credentialId")
                    passkeyJson.has("id") -> passkeyJson.opt("id")
                    else -> passkeyJson.opt("rawId")
                }
            ) ?: continue
            val rpId = extractRpId(passkeyJson) ?: continue

            val transports = mutableListOf<String>()
            val transportsJson = passkeyJson.optJSONArray("transports")
            if (transportsJson != null) {
                for (transportIndex in 0 until transportsJson.length()) {
                    val transport = transportsJson.optString(transportIndex)
                    if (transport.isNotBlank()) {
                        transports.add(transport)
                    }
                }
            }

            passkeys.add(
                StoredPasskey(
                    credentialId = credentialId,
                    rpId = rpId,
                    rpName = passkeyJson.optString("rpName").ifBlank { rpId },
                    userHandle = canonicalizeCredentialIdValue(passkeyJson.opt("userHandle")).orEmpty(),
                    userName = passkeyJson.optString("userName").orEmpty(),
                    userDisplayName = passkeyJson.optString("userDisplayName").ifBlank {
                        passkeyJson.optString("userName").orEmpty()
                    },
                    privateKey = passkeyJson.optString("privateKey").orEmpty(),
                    publicKey = passkeyJson.optString("publicKey").orEmpty(),
                    algorithm = passkeyJson.optInt("algorithm", -7),
                    signCount = passkeyJson.optInt("signCount", 0),
                    transports = transports.ifEmpty { listOf("internal", "hybrid") },
                    createdAt = passkeyJson.optString("createdAt").orEmpty(),
                    lastUsedAt = passkeyJson.optString("lastUsedAt").takeIf { it.isNotBlank() },
                    status = passkeyJson.optString("status").takeIf { it.isNotBlank() },
                    statusReason = passkeyJson.optString("statusReason").takeIf { it.isNotBlank() },
                    statusUpdatedAt = passkeyJson.optString("statusUpdatedAt").takeIf { it.isNotBlank() }
                )
            )
        }
        return passkeys
    }

    fun writeStoredPasskeys(itemDataJson: JSONObject, passkeys: List<StoredPasskey>) {
        if (passkeys.isEmpty()) {
            itemDataJson.remove("passkeys")
            return
        }

        val array = JSONArray()
        for (passkey in passkeys) {
            val json = JSONObject().apply {
                put("credentialId", canonicalizeCredentialId(passkey.credentialId) ?: passkey.credentialId)
                put("rpId", normalizeHost(passkey.rpId))
                put("rpName", passkey.rpName)
                put("userHandle", canonicalizeCredentialId(passkey.userHandle) ?: passkey.userHandle)
                put("userName", passkey.userName)
                put("userDisplayName", passkey.userDisplayName)
                put("privateKey", passkey.privateKey)
                put("publicKey", passkey.publicKey)
                put("algorithm", passkey.algorithm)
                put("signCount", passkey.signCount)
                put("createdAt", passkey.createdAt)
                passkey.lastUsedAt?.let { put("lastUsedAt", it) }
                passkey.status?.let { put("status", it) }
                passkey.statusReason?.let { put("statusReason", it) }
                passkey.statusUpdatedAt?.let { put("statusUpdatedAt", it) }

                val transportsJson = JSONArray()
                for (transport in passkey.transports) {
                    transportsJson.put(transport)
                }
                put("transports", transportsJson)
            }
            array.put(json)
        }

        itemDataJson.put("passkeys", array)
    }

    fun canonicalizeCredentialId(value: String?): String? {
        if (value.isNullOrBlank()) return null
        return try {
            encodeBase64Url(decodeBase64OrBase64Url(value))
        } catch (_: Exception) {
            value.trim().trimEnd('=').replace('+', '-').replace('/', '_')
        }
    }

    fun decodeBase64OrBase64Url(value: String): ByteArray {
        val trimmed = value.trim()
        if (trimmed.isEmpty()) return ByteArray(0)

        return try {
            Base64.decode(trimmed, Base64.NO_WRAP)
        } catch (_: IllegalArgumentException) {
            val normalized = trimmed.replace('-', '+').replace('_', '/')
            val padded = when (normalized.length % 4) {
                2 -> "$normalized=="
                3 -> "$normalized="
                else -> normalized
            }
            Base64.decode(padded, Base64.NO_WRAP)
        }
    }

    fun encodeBase64(data: ByteArray): String {
        return Base64.encodeToString(data, Base64.NO_WRAP)
    }

    fun encodeBase64Url(data: ByteArray): String {
        return Base64.encodeToString(
            data,
            Base64.NO_WRAP or Base64.NO_PADDING or Base64.URL_SAFE
        )
    }

    private fun parseRequestSource(requestJson: String): JSONObject {
        val root = JSONObject(requestJson)
        return root.optJSONObject("publicKey") ?: root
    }

    private fun canonicalizeCredentialIdValue(value: Any?): String? {
        return when (value) {
            is String -> canonicalizeCredentialId(value)
            is JSONArray -> {
                val bytes = ByteArray(value.length())
                for (index in 0 until value.length()) {
                    val numeric = value.optInt(index, -1)
                    if (numeric !in 0..255) return null
                    bytes[index] = numeric.toByte()
                }
                encodeBase64Url(bytes)
            }
            else -> null
        }
    }

    private fun extractRpId(passkeyJson: JSONObject): String? {
        val rpId = when {
            passkeyJson.has("rpId") -> passkeyJson.optString("rpId")
            passkeyJson.has("rpID") -> passkeyJson.optString("rpID")
            passkeyJson.has("domain") -> passkeyJson.optString("domain")
            else -> passkeyJson.optJSONObject("rp")?.optString("id").orEmpty()
        }

        return normalizeHost(rpId).takeIf { it.isNotEmpty() }
    }
}

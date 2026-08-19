package com.bittery.mobile.credentialprovider.vault

import com.bittery.mobile.credentialprovider.domain.DomainMatch
import org.json.JSONArray
import org.json.JSONObject

/**
 * One full sync payload, parsed and checked.
 *
 * The app sends everything the replica should hold for one account, and the
 * travel-mode policy that governs it. The two arrive together on purpose: the
 * vault commits the policy before it writes a row, so no row is ever queryable
 * under the policy that preceded it.
 *
 * The app also filters a hidden vault out before it syncs, so in practice one
 * never arrives. [travelMode] is what makes that a convenience rather than the
 * defence: the vault erases and refuses hidden vaults on its own.
 */
internal data class CredentialReplicaSnapshot(
    val accountId: String,
    val serverUserId: String,
    val email: String,
    val secretKey: String,
    val kdf: KdfProfile,
    val vaultKeys: List<ReplicaVaultKey>,
    val items: List<ReplicaItem>,
    /**
     * Item id to the URLs sync sent for it, in order.
     *
     * Kept beside the items rather than on them: the domain index holds several
     * rows per URL, and an item that is skipped still has to leave its old rows
     * alone.
     */
    val itemUrls: Map<String, List<String>>,
    /**
     * The account's travel-mode policy, or `null` when the app verified none.
     *
     * `null` is not "travel mode is off" — it is "nobody could say". The vault
     * fails closed on it, the way `TravelModeEnforcer.verifyOrClear` does.
     */
    val travelMode: NativeTravelModePolicy?,
) {

    /** The same snapshot with everything the policy hides taken out of it. */
    fun withoutVaultsHiddenBy(policy: NativeTravelModePolicy): CredentialReplicaSnapshot {
        val hidden = policy.suppressedVaultIds
        if (hidden.isEmpty()) return this

        val keptItems = items.filter { it.vaultId !in hidden }
        val keptItemIds = keptItems.mapTo(HashSet()) { it.id }
        return copy(
            vaultKeys = vaultKeys.filter { it.vaultId !in hidden },
            items = keptItems,
            itemUrls = itemUrls.filterKeys { it in keptItemIds },
        )
    }
}

internal sealed interface ReplicaSnapshotParse {
    data class Parsed(val snapshot: CredentialReplicaSnapshot) : ReplicaSnapshotParse

    data class Rejected(val reason: String) : ReplicaSnapshotParse
}

/**
 * Reads the sync payload the app sends over the bridge.
 *
 * The rules are the ones the bridge has always applied: both identities and a
 * complete KDF profile or nothing is written; only login items are kept; a record
 * that does not carry every field it needs is skipped rather than guessed at.
 */
internal object CredentialReplicaSnapshots {

    private const val KDF_SCHEMA_VERSION = 1
    private const val KDF_ALGORITHM = "pbkdf2-sha256"
    private val KDF_ITERATIONS = 600_000..1_200_000

    fun parse(dataJson: String, logger: VaultLogger = VaultLogger.None): ReplicaSnapshotParse {
        val root = JSONObject(dataJson)

        // Both identities are named. `accountId` keys the live unlock state,
        // `serverUserId` keys the replica rows. Neither has a fallback.
        val accountId = root.optString("accountId", "")
        val serverUserId = root.optString("userId", "")
        val email = root.optString("email", "")
        val secretKey = root.optString("secretKey", "")
        val kdfProfile = root.optJSONObject("kdfProfile")

        if (
            accountId.isBlank() ||
            serverUserId.isBlank() ||
            email.isBlank() ||
            secretKey.isBlank() ||
            kdfProfile == null
        ) {
            return ReplicaSnapshotParse.Rejected("Complete account and KDF profile data is required")
        }

        val kdf = KdfProfile(
            schemaVersion = kdfProfile.optInt("schemaVersion", -1),
            algorithm = kdfProfile.optString("algorithm", ""),
            iterations = kdfProfile.optInt("iterations", -1),
        )
        if (
            kdf.schemaVersion != KDF_SCHEMA_VERSION ||
            kdf.algorithm != KDF_ALGORITHM ||
            kdf.iterations !in KDF_ITERATIONS
        ) {
            return ReplicaSnapshotParse.Rejected("Invalid KDF profile")
        }

        val vaultKeysJson = root.optJSONArray("vaultKeys") ?: JSONArray()
        val itemsJson = root.optJSONArray("items") ?: JSONArray()

        // Read once, then used twice: the index needs every URL, an item needs the
        // first one. Two readings of the same field is how they drifted apart.
        val itemUrls = parseItemUrls(itemsJson, logger)

        return ReplicaSnapshotParse.Parsed(
            CredentialReplicaSnapshot(
                accountId = accountId,
                serverUserId = serverUserId,
                email = email,
                secretKey = secretKey,
                kdf = kdf,
                vaultKeys = parseVaultKeys(vaultKeysJson, serverUserId, logger),
                items = parseItems(itemsJson, serverUserId, itemUrls, logger),
                itemUrls = itemUrls,
                travelMode = parseTravelMode(root.optJSONObject("travelMode")),
            ),
        )
    }

    /**
     * The travel-mode policy, or nothing.
     *
     * "Nothing" covers both an absent policy and one the app marked unverified —
     * neither is a licence to serve. The app sets `verified` from
     * `TravelModeEnforcer.isVerified`, which is true only after the policy came
     * from the server or from the store that the server last wrote.
     */
    private fun parseTravelMode(json: JSONObject?): NativeTravelModePolicy? {
        if (json == null || !json.optBoolean("verified", false)) return null

        val hiddenJson = json.optJSONArray("hiddenVaultIds") ?: JSONArray()
        val hidden = (0 until hiddenJson.length())
            .mapNotNull { hiddenJson.optString(it, "").takeIf { id -> id.isNotBlank() } }
            .toSet()

        return NativeTravelModePolicy(
            enabled = json.optBoolean("enabled", false),
            hiddenVaultIds = hidden,
            updatedAtMs = if (json.isNull("updatedAt")) null else json.optLong("updatedAt"),
        )
    }

    private fun parseVaultKeys(
        vaultKeysJson: JSONArray,
        serverUserId: String,
        logger: VaultLogger,
    ): List<ReplicaVaultKey> = fields(vaultKeysJson).mapNotNull { keyData ->
        try {
            ReplicaVaultKey(
                vaultId = keyData["vaultId"] as? String ?: return@mapNotNull null,
                serverUserId = serverUserId,
                vaultName = keyData["vaultName"] as? String ?: return@mapNotNull null,
                vaultType = keyData["vaultType"] as? String ?: return@mapNotNull null,
                encryptedKey = keyData["encryptedKey"] as? String ?: return@mapNotNull null,
                encryptionIv = keyData["encryptionIv"] as? String ?: return@mapNotNull null,
                encryptionAlgorithm = keyData["encryptionAlgorithm"] as? String
                    ?: return@mapNotNull null,
                role = keyData["role"] as? String ?: return@mapNotNull null,
                keyVersion = (keyData["keyVersion"] as? Number)?.toLong() ?: return@mapNotNull null,
            )
        } catch (e: Exception) {
            logger.warn("Failed to parse vault key: ${keyData["vaultId"]}", e)
            null
        }
    }

    private fun parseItems(
        itemsJson: JSONArray,
        serverUserId: String,
        itemUrls: Map<String, List<String>>,
        logger: VaultLogger,
    ): List<ReplicaItem> = fields(itemsJson).mapNotNull { itemData ->
        try {
            val itemId = itemData["id"] as? String ?: return@mapNotNull null
            val vaultId = itemData["vaultId"] as? String ?: return@mapNotNull null
            val category = itemData["category"] as? String ?: return@mapNotNull null

            // Only login items are replicated. Nothing else can be autofilled.
            if (category != "login") return@mapNotNull null

            // The first URL the item carries, as the domain index read it. Reading
            // `urls` off the flattened object instead always answered nothing, so
            // every label that names this domain fell through to "Login".
            val primaryDomain = itemUrls[itemId]?.firstOrNull()
                ?.let { DomainMatch.normalizeHost(it) }
                ?.takeIf { it.isNotEmpty() }

            val now = System.currentTimeMillis()
            ReplicaItem(
                id = itemId,
                vaultId = vaultId,
                serverUserId = serverUserId,
                category = category,
                displayTitle = itemData["displayTitle"] as? String ?: "",
                encryptedData = itemData["encryptedData"] as? String ?: return@mapNotNull null,
                encryptionIv = itemData["encryptionIv"] as? String ?: return@mapNotNull null,
                encryptionAlgorithm = itemData["encryptionAlgorithm"] as? String
                    ?: return@mapNotNull null,
                primaryDomain = primaryDomain,
                username = itemData["username"] as? String,
                iconUrl = itemData["iconUrl"] as? String,
                lastUsedAtMs = (itemData["lastUsedAt"] as? Number)?.toLong() ?: 0L,
                syncedAtMs = now,
                createdAtMs = (itemData["createdAt"] as? Number)?.toLong() ?: now,
                updatedAtMs = (itemData["updatedAt"] as? Number)?.toLong() ?: now,
                isFavorite = itemData["isFavorite"] as? Boolean ?: false,
                version = (itemData["version"] as? Number)?.toLong() ?: return@mapNotNull null,
                lastModifiedBy = itemData["lastModifiedBy"] as? String,
                encryptionVersion = (itemData["encryptionVersion"] as? Number)?.toLong()
                    ?: return@mapNotNull null,
                encryptedByServerUserId = itemData["encryptedByUserId"] as? String
                    ?: return@mapNotNull null,
            )
        } catch (e: Exception) {
            logger.warn("Failed to parse item: ${itemData["id"]}", e)
            null
        }
    }

    /**
     * The URLs, read straight off the JSON rather than off the flattened map.
     *
     * A JSON array arrives as a `JSONArray`, which is not a `List`, so the
     * flattened view above cannot see one. This is the only reading of the field:
     * both the domain index and each item's primary domain come from here.
     */
    private fun parseItemUrls(
        itemsJson: JSONArray,
        logger: VaultLogger,
    ): Map<String, List<String>> {
        val urlsByItemId = LinkedHashMap<String, List<String>>()
        for (index in 0 until itemsJson.length()) {
            try {
                val item = itemsJson.getJSONObject(index)
                val itemId = item.optString("id", "")
                if (itemId.isEmpty()) continue
                if (item.optString("category", "") != "login") continue

                val urlsJson = item.optJSONArray("urls") ?: JSONArray()
                urlsByItemId[itemId] = (0 until urlsJson.length()).map { urlsJson.getString(it) }
            } catch (e: Exception) {
                logger.warn("Failed to read URLs for the item at index $index", e)
            }
        }
        return urlsByItemId
    }

    /** A JSON object as a plain map, which is how the bridge has always read these. */
    private fun fields(array: JSONArray): List<Map<String, Any>> =
        (0 until array.length()).map { index ->
            val obj = array.getJSONObject(index)
            obj.keys().asSequence().associateWith { key -> obj.get(key) }
        }
}

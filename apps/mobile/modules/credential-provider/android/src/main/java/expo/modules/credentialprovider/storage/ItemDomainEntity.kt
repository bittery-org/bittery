package expo.modules.credentialprovider.storage

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Junction table for item-to-domain relationships.
 *
 * A login item can have multiple URLs (e.g., login.example.com, www.example.com).
 * This table allows efficient domain-based credential lookup without LIKE queries.
 *
 * When syncing items with multiple URLs, create one ItemDomainEntity per URL/domain.
 */
@Entity(
    tableName = "item_domains",
    indices = [
        Index(value = ["domain"]),
        Index(value = ["itemId"]),
        Index(value = ["domain", "isPrimary"])
    ],
    foreignKeys = [
        ForeignKey(
            entity = ItemEntity::class,
            parentColumns = ["id"],
            childColumns = ["itemId"],
            onDelete = ForeignKey.CASCADE
        )
    ]
)
data class ItemDomainEntity(
    /** Auto-generated primary key */
    @PrimaryKey(autoGenerate = true)
    val id: Long = 0,

    /** Item ID this domain belongs to */
    val itemId: String,

    /** The domain for autofill matching (e.g., "example.com", "login.example.com") */
    val domain: String,

    /** Whether this is the primary/first domain for the item */
    val isPrimary: Boolean = false,

    /** The full URL this domain was extracted from */
    val fullUrl: String? = null
)

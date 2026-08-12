package expo.modules.credentialprovider.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Update

@Dao
abstract class PasskeyMutationDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    protected abstract suspend fun insertItem(item: ItemEntity)

    @Update
    protected abstract suspend fun updateItem(item: ItemEntity)

    @Query("DELETE FROM item_domains WHERE itemId = :itemId")
    protected abstract suspend fun deleteDomains(itemId: String)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    protected abstract suspend fun writeDomains(domains: List<ItemDomainEntity>)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    protected abstract suspend fun writePendingMutation(mutation: PendingPasskeyMutationEntity)

    @Transaction
    open suspend fun updateItemAndQueue(
        item: ItemEntity,
        mutation: PendingPasskeyMutationEntity
    ) {
        updateItem(item)
        writePendingMutation(mutation)
    }

    @Transaction
    open suspend fun createItemAndQueue(
        item: ItemEntity,
        domains: List<ItemDomainEntity>,
        mutation: PendingPasskeyMutationEntity
    ) {
        insertItem(item)
        deleteDomains(item.id)
        writeDomains(domains)
        writePendingMutation(mutation)
    }
}

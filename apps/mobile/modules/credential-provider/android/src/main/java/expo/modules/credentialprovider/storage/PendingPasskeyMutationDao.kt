package expo.modules.credentialprovider.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

/**
 * Data Access Object for queued passkey mutations.
 */
@Dao
interface PendingPasskeyMutationDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(entity: PendingPasskeyMutationEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(entities: List<PendingPasskeyMutationEntity>)

    @Query("SELECT * FROM pending_passkey_mutations ORDER BY createdAt ASC")
    suspend fun getAll(): List<PendingPasskeyMutationEntity>

    @Query("SELECT * FROM pending_passkey_mutations WHERE userId = :userId ORDER BY createdAt ASC")
    suspend fun getByUserId(userId: String): List<PendingPasskeyMutationEntity>

    @Query("DELETE FROM pending_passkey_mutations WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<String>)

    @Query(
        """
        UPDATE pending_passkey_mutations
        SET attemptCount = attemptCount + 1, lastError = :error
        WHERE id IN (:ids)
    """
    )
    suspend fun markFailed(ids: List<String>, error: String)

    @Query("DELETE FROM pending_passkey_mutations")
    suspend fun deleteAll()
}

WITH latest_known_encryption AS (
    SELECT DISTINCT ON (event.entity_id)
        event.entity_id,
        event.version,
        event.user_id,
        event.seq
    FROM sync_event AS event
    INNER JOIN "user" AS author ON author.id = event.user_id
    WHERE event.entity_type = 'item'::sync_entity_type
      AND event.event_type IN (
          'item_created'::sync_event_type,
          'item_moved'::sync_event_type
      )
    ORDER BY event.entity_id, event.seq DESC
), provable_context AS (
    SELECT candidate.entity_id, candidate.version, candidate.user_id
    FROM latest_known_encryption AS candidate
    WHERE NOT EXISTS (
        SELECT 1
        FROM sync_event AS later
        WHERE later.entity_type = 'item'::sync_entity_type
          AND later.entity_id = candidate.entity_id
          AND later.seq > candidate.seq
          AND later.event_type IN (
              'item_created'::sync_event_type,
              'item_updated'::sync_event_type,
              'item_moved'::sync_event_type
          )
    )
)
UPDATE item
SET encryption_version = context.version,
    encrypted_by_user_id = context.user_id
FROM provable_context AS context
WHERE item.id = context.entity_id
  AND item.encryption_version IS NULL
  AND item.encrypted_by_user_id IS NULL
  AND context.version <= item.version;

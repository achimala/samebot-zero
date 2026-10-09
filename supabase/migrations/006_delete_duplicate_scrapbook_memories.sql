-- Overlapping key-message detections and restarts saved the same quote
-- several times, so one search posted the same memory once per copy.
-- Keep the oldest copy of each quote.
DELETE FROM scrapbook_memories duplicate
USING scrapbook_memories original
WHERE duplicate.key_message = original.key_message
  AND (
    duplicate.created_at > original.created_at
    OR (duplicate.created_at = original.created_at AND duplicate.id > original.id)
  );

-- Create scrapbook_memories table for storing memorable chat moments
CREATE TABLE IF NOT EXISTS scrapbook_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_message TEXT NOT NULL,
  author TEXT NOT NULL,
  context JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for random selection and ordering by recency
CREATE INDEX IF NOT EXISTS idx_scrapbook_memories_created_at ON scrapbook_memories(created_at);

-- Full-text search index for searching memories
CREATE INDEX IF NOT EXISTS idx_scrapbook_memories_key_message_search ON scrapbook_memories USING gin(to_tsvector('english', key_message));

-- Function to get a random memory
CREATE OR REPLACE FUNCTION get_random_scrapbook_memory()
RETURNS TABLE (
  id UUID,
  key_message TEXT,
  author TEXT,
  context JSONB,
  created_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.key_message,
    m.author,
    m.context,
    m.created_at
  FROM scrapbook_memories m
  ORDER BY random()
  LIMIT 1;
END;
$$;

-- Function to search memories by text
CREATE OR REPLACE FUNCTION search_scrapbook_memories(
  search_query TEXT,
  result_limit INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  key_message TEXT,
  author TEXT,
  context JSONB,
  created_at TIMESTAMP WITH TIME ZONE,
  rank REAL
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.key_message,
    m.author,
    m.context,
    m.created_at,
    ts_rank(to_tsvector('english', m.key_message), plainto_tsquery('english', search_query)) AS rank
  FROM scrapbook_memories m
  WHERE to_tsvector('english', m.key_message) @@ plainto_tsquery('english', search_query)
  ORDER BY rank DESC
  LIMIT result_limit;
END;
$$;


-- plainto_tsquery joins words with AND, so "spicy maymay" missed a quote
-- containing only "spicy". Match any word instead; ts_rank still ranks quotes
-- matching more of the words first.
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
DECLARE
  any_term_query tsquery := replace(
    plainto_tsquery('english', search_query)::text,
    ' & ',
    ' | '
  )::tsquery;
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.key_message,
    m.author,
    m.context,
    m.created_at,
    ts_rank(to_tsvector('english', m.key_message), any_term_query) AS rank
  FROM scrapbook_memories m
  WHERE to_tsvector('english', m.key_message) @@ any_term_query
  ORDER BY rank DESC
  LIMIT result_limit;
END;
$$;

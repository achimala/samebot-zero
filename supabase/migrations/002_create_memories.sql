-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Create memories table
CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  embedding vector(768) NOT NULL,
  strength FLOAT NOT NULL DEFAULT 1.0,
  last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for vector similarity search using ivfflat
CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Create index for strength-based queries
CREATE INDEX IF NOT EXISTS idx_memories_strength ON memories(strength);

-- Create index for last_seen_at for decay calculations
CREATE INDEX IF NOT EXISTS idx_memories_last_seen_at ON memories(last_seen_at);

-- Create function for vector similarity search
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding vector(768),
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  embedding vector(768),
  strength FLOAT,
  last_seen_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.embedding,
    m.strength,
    m.last_seen_at,
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memories m
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


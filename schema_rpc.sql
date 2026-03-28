-- RPC function for vector similarity search
-- Run this in Supabase SQL editor after creating the notes table

CREATE OR REPLACE FUNCTION search_notes_by_embedding(
  p_user_phone TEXT,
  p_embedding VECTOR(384),
  p_limit INTEGER DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  user_phone TEXT,
  content TEXT,
  summary TEXT,
  tags TEXT[],
  people TEXT[],
  projects TEXT[],
  topics TEXT[],
  status TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE SQL
STABLE
AS $$
  SELECT
    id, user_phone, content, summary, tags, people, projects, topics, status, created_at, updated_at
  FROM notes
  WHERE user_phone = p_user_phone
    AND status = 'active'
    AND embedding IS NOT NULL
  ORDER BY embedding <=> p_embedding
  LIMIT p_limit;
$$;

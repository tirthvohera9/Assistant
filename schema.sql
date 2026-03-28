-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Table: episodes
CREATE TABLE episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_phone TEXT NOT NULL,
  raw_input TEXT NOT NULL,
  input_type TEXT CHECK (input_type IN ('text','voice','image','document')),
  transcribed_text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table: notes
CREATE TABLE notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_phone TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  embedding VECTOR(384),
  tags TEXT[],
  people TEXT[],
  projects TEXT[],
  topics TEXT[],
  status TEXT DEFAULT 'active' CHECK (status IN ('active','done','archived')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table: reminders
CREATE TABLE reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_phone TEXT NOT NULL,
  note_id UUID REFERENCES notes(id),
  message TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','sent','snoozed','done')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table: entities
CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_phone TEXT NOT NULL,
  entity_type TEXT CHECK (entity_type IN ('person','project','topic')),
  name TEXT NOT NULL,
  last_mentioned TIMESTAMPTZ DEFAULT NOW(),
  open_items INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  UNIQUE(user_phone, entity_type, name)
);

-- Table: user_rules
CREATE TABLE user_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_phone TEXT NOT NULL,
  rule_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table: users
CREATE TABLE users (
  phone TEXT PRIMARY KEY,
  briefing_time TEXT DEFAULT '07:30',
  timezone TEXT DEFAULT 'Asia/Kolkata',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for vector search
CREATE INDEX ON notes USING ivfflat (embedding vector_cosine_ops);

-- pg_cron jobs (run after enabling pg_cron and pg_net extensions)
-- Replace YOUR_WORKER_URL with your actual Cloudflare Worker URL
SELECT cron.schedule('check-reminders', '* * * * *', $$
  SELECT net.http_post(
    url := 'https://YOUR_WORKER_URL/cron/reminders',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);

SELECT cron.schedule('daily-briefing', '0 2 * * *', $$
  SELECT net.http_post(
    url := 'https://YOUR_WORKER_URL/cron/briefing',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);

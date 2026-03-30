-- Chief Bot - Feature Migration v2
-- Run this in your Supabase SQL Editor before deploying

-- Feature 1: Recurring reminders
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS recurrence TEXT DEFAULT 'none';
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

-- Feature 3: Pin/star notes
ALTER TABLE notes ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT false;

-- Feature 4: Conversation context (last 5 message pairs per user)
ALTER TABLE users ADD COLUMN IF NOT EXISTS context JSONB DEFAULT '[]'::jsonb;

-- Index for pinned notes sorting (improves list query performance)
CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(user_phone, pinned DESC, created_at DESC) WHERE status = 'active';

-- Index for sent reminders (for re-notification query)
CREATE INDEX IF NOT EXISTS idx_reminders_sent ON reminders(status, sent_at) WHERE status = 'sent';

# Chief — WhatsApp AI Assistant

A personal note-taking and memory system delivered via WhatsApp.

## Stack

- **WhatsApp**: Meta Cloud API
- **Hosting**: Cloudflare Workers
- **LLM + Transcription**: Groq API (llama-3.3-70b-versatile + whisper-large-v3)
- **Database**: Supabase (PostgreSQL + pgvector + pg_cron)
- **Embeddings**: HuggingFace Inference API (sentence-transformers/all-MiniLM-L6-v2)

## Setup

### 1. Supabase

Run SQL files in this order in your Supabase SQL Editor:

```
schema.sql       — tables, extensions, indexes
schema_rpc.sql   — vector search RPC function
```

Enable `pg_cron` and `pg_net` extensions in Supabase dashboard, then update `YOUR_WORKER_URL` in `schema.sql` and run the cron job `SELECT cron.schedule(...)` statements.

### 2. Cloudflare Worker

Install dependencies:

```bash
npm install
```

Set secrets via Wrangler (do NOT commit real values):

```bash
wrangler secret put WHATSAPP_TOKEN
wrangler secret put WHATSAPP_PHONE_NUMBER_ID
wrangler secret put WHATSAPP_VERIFY_TOKEN
wrangler secret put GROQ_API_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put HUGGINGFACE_API_KEY
```

Deploy:

```bash
npm run deploy
```

### 3. WhatsApp Webhook

In Meta Developer Console:
- Set Webhook URL to: `https://your-worker.workers.dev/webhook`
- Set Verify Token to match `WHATSAPP_VERIFY_TOKEN`
- Subscribe to `messages` webhook field

## Environment Variables

| Variable | Description |
|---|---|
| `WHATSAPP_TOKEN` | Meta Cloud API permanent token |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Business Phone Number ID |
| `WHATSAPP_VERIFY_TOKEN` | Custom string for webhook verification |
| `GROQ_API_KEY` | Groq API key |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `HUGGINGFACE_API_KEY` | HuggingFace API token |

## Routes

| Route | Method | Description |
|---|---|---|
| `/webhook` | GET | WhatsApp webhook verification |
| `/webhook` | POST | Incoming WhatsApp messages |
| `/cron/reminders` | POST | Check and send due reminders |
| `/cron/briefing` | POST | Send daily morning briefings |

## Supported Intents

| Intent | Example |
|---|---|
| `save_note` | "Remind me to call John tomorrow" / "Note: meeting at 3pm" |
| `set_reminder` | "Remind me at 5pm to submit the report" |
| `search_notes` | "Find my notes about the project proposal" |
| `show_list` | "Show my notes from today" |
| `mark_done` | "Done with the design review" |
| `snooze` | "Snooze this reminder" / "Remind me tomorrow" |
| `update_rule` | "Always remind me 30 minutes before meetings" |
| `query_entity` | "What do I have on Rahul?" / "Status of Project X?" |

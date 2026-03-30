const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

// Fallback chain — tried in order if previous is rate-limited (429)
const FALLBACK_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'nousresearch/hermes-3-llama-3.1-405b:free',
  'openai/gpt-oss-120b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'google/gemma-3-27b-it:free'
];

function getModelChain(env) {
  const primary = env.OPENROUTER_MODEL || FALLBACK_MODELS[0];
  // Put primary first, then the rest of fallbacks (excluding primary to avoid dupes)
  return [primary, ...FALLBACK_MODELS.filter(m => m !== primary)];
}

function getHeaders(env) {
  return {
    'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://chief-assistant.workers.dev',
    'X-Title': 'Chief Personal Assistant'
  };
}

async function chatCompletion(env, messages, options = {}) {
  const models = getModelChain(env);
  let lastError;

  for (const model of models) {
    try {
      const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: getHeaders(env),
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.2,
          max_tokens: options.max_tokens ?? 1024
        })
      });

      if (response.status === 429 || response.status === 503) {
        const err = await response.text();
        console.warn(`Model ${model} rate-limited, trying next. Error: ${err}`);
        lastError = new Error(`Rate limited: ${model}`);
        continue; // try next model
      }

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenRouter error [${response.status}] for ${model}: ${err}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim() || '';
      if (content) {
        if (model !== models[0]) console.log(`Used fallback model: ${model}`);
        return content;
      }
    } catch (err) {
      if (err.message.startsWith('Rate limited:')) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('All models failed');
}

function extractJSON(text) {
  // Try direct parse first
  try { return JSON.parse(text); } catch {}
  // Extract JSON from markdown code block
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (block) try { return JSON.parse(block[1].trim()); } catch {}
  // Extract first {...} block
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) try { return JSON.parse(brace[0]); } catch {}
  return null;
}

async function groqFallback(env, messages) {
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages,
        temperature: 0.2,
        max_tokens: 1024,
        response_format: { type: 'json_object' }
      })
    });
    if (!response.ok) throw new Error(`Groq fallback failed: ${response.status}`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    return JSON.parse(content);
  } catch (err) {
    console.error('Groq fallback also failed:', err);
    return { intent: 'unclear', reply_message: "I'm not sure what you meant. Please try again." };
  }
}

export async function getLLMResponse(env, userMessage, userRules, context = [], userTimezone = 'Asia/Kolkata') {
  const now = new Date().toISOString();
  const rulesText = userRules && userRules.length > 0
    ? userRules.map(r => r.rule_text).join('\n')
    : 'None';

  const systemPrompt = `You are Chief, a personal AI assistant. You MUST respond with ONLY a valid JSON object — no markdown, no explanation, no code blocks, just raw JSON.

{
  "intent": "save_note|save_checklist|set_reminder|search_notes|show_list|show_topics|mark_done|edit_note|delete_note|delete_reminder|snooze|update_rule|query_entity|answer_question|pin_note|export_notes|set_timezone|bulk_action|unclear",
  "note_content": "cleaned note text when SAVING a note only",
  "new_content": "replacement text when EDITING a note",
  "edit_search_query": "keywords to find the existing note/reminder to edit, delete, or cancel",
  "note_number": null,
  "reminder_time_iso": "ISO8601 datetime if reminder, else null",
  "reminder_message": "reminder text if applicable",
  "recurrence": "none|daily|weekly|monthly",
  "search_query": "query string if searching notes",
  "entity_query": "person or project name if querying entity",
  "list_filter": "all|today|week",
  "topic_filter": "topic name if user wants notes by topic, else null",
  "snooze_duration": "1h|tomorrow|null",
  "snooze_search_query": "keywords to find the specific reminder to snooze",
  "rule_text": "rule to save if updating rule",
  "delete_all": false,
  "people": ["array of people mentioned"],
  "projects": ["array of projects mentioned"],
  "topics": ["array of topics mentioned"],
  "tags": ["array of relevant tags"],
  "reply_message": "brief confirmation message to send user",
  "checklist_items": ["item1", "item2"],
  "timezone_value": "IANA timezone string if user is setting timezone, else null",
  "bulk_target": "reminders_today|null",
  "smart_reminder_time": "ISO8601 datetime if note contains a future date/event, else null",
  "pin": false
}

IMPORTANT RULES:
- "delete all notes", "clear all notes" → intent: delete_note, delete_all: true
- "edit note 1 to X" → intent: edit_note, note_number: 1, new_content: "X"
- "delete note 1" → intent: delete_note, note_number: 1
- "pin note 1" → intent: pin_note, note_number: 1, pin: true
- "unpin note 1" → intent: pin_note, note_number: 1, pin: false
- "make a checklist: milk, eggs" → intent: save_checklist, checklist_items: ["milk", "eggs"]
- "show topics" → intent: show_topics
- "show notes about [topic]" → intent: show_list, topic_filter: "[topic]"
- "export my notes" → intent: export_notes
- "my timezone is X" → intent: set_timezone, timezone_value: "X"
- "remind me every day/week/month" → recurrence: "daily"/"weekly"/"monthly"
- "mark all reminders done" → intent: bulk_action, bulk_target: "reminders_today"
- If note contains a specific future date/time, set smart_reminder_time
- Use conversation history to resolve "yes", "that one", "it", "both" etc.
- note_number: integer when user refers to note by list position
- For edits: new_content = replacement, edit_search_query = original note keywords

Current datetime: ${now}
User timezone: ${userTimezone}
User rules: ${rulesText}`;

  const messages = [{ role: 'system', content: systemPrompt }];
  if (Array.isArray(context) && context.length > 0) {
    messages.push(...context.slice(-8));
  }
  messages.push({ role: 'user', content: userMessage });

  try {
    const content = await chatCompletion(env, messages, { temperature: 0.2, max_tokens: 1024 });
    const parsed = extractJSON(content);
    if (!parsed) throw new Error(`Could not parse JSON from: ${content.substring(0, 100)}`);
    return parsed;
  } catch (err) {
    console.warn('OpenRouter failed, falling back to Groq:', err.message);
    // Hard fallback to Groq — guaranteed to work
    return await groqFallback(env, messages);
  }
}

export async function summarizeEntity(env, entityName, notesText) {
  const content = await chatCompletion(env, [
    {
      role: 'system',
      content: 'You are Chief, a personal AI assistant. Summarize the following notes about a person or project concisely.'
    },
    {
      role: 'user',
      content: `Summarize all notes about "${entityName}":\n\n${notesText}`
    }
  ], { temperature: 0.3, max_tokens: 512 });

  return content || 'No summary available.';
}

export async function composeBriefing(env, { reminders, notes, entities }) {
  const context = [
    reminders?.length > 0 ? `Reminders today:\n${reminders.map(r => `- ${r.message} (due: ${new Date(r.due_at).toLocaleTimeString('en-IN')})`).join('\n')}` : '',
    notes?.length > 0 ? `Recent notes:\n${notes.map(n => `- ${n.content.substring(0, 80)}`).join('\n')}` : '',
    entities?.length > 0 ? `Open items:\n${entities.map(e => `- ${e.name} (${e.entity_type}): ${e.open_items} open items`).join('\n')}` : ''
  ].filter(Boolean).join('\n\n');

  if (!context) return 'Good morning! No pending items for today.';

  try {
    const result = await chatCompletion(env, [
      {
        role: 'system',
        content: 'You are Chief, a personal AI assistant. Compose a concise morning briefing. Be friendly and structured.'
      },
      {
        role: 'user',
        content: `Compose morning briefing:\n\n${context}`
      }
    ], { temperature: 0.4, max_tokens: 512 });

    return result || `Good morning!\n\n${context}`;
  } catch {
    return `Good morning! Here's your briefing:\n\n${context}`;
  }
}

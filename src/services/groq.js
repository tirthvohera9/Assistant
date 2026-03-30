const GROQ_API_BASE = 'https://api.groq.com/openai/v1';

export async function transcribeAudio(env, audioBuffer) {
  const formData = new FormData();
  const blob = new Blob([audioBuffer], { type: 'audio/ogg' });
  formData.append('file', blob, 'audio.ogg');
  formData.append('model', 'whisper-large-v3');
  formData.append('response_format', 'text');

  const response = await fetch(`${GROQ_API_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GROQ_API_KEY}`
    },
    body: formData
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq transcription failed: ${err}`);
  }

  const text = await response.text();
  return text.trim();
}

export async function extractTextFromMedia(env, mediaBuffer, mediaType) {
  const base64 = bufferToBase64(mediaBuffer);
  const mimeType = mediaType === 'image' ? 'image/jpeg' : 'application/pdf';

  const response = await fetch(`${GROQ_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.2-11b-vision-preview',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64}`
              }
            },
            {
              type: 'text',
              text: 'Extract and return all text from this image or document. Return only the extracted text, nothing else.'
            }
          ]
        }
      ],
      max_tokens: 1024
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq vision failed: ${err}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

export async function getLLMResponse(env, userMessage, userRules, context = [], userTimezone = 'Asia/Kolkata') {
  const now = new Date().toISOString();
  const rulesText = userRules && userRules.length > 0
    ? userRules.map(r => r.rule_text).join('\n')
    : 'None';

  const systemPrompt = `You are Chief, a personal AI assistant. Analyze the user message and return ONLY valid JSON.

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
- "delete all notes", "clear all notes", "remove all notes" → intent: delete_note, delete_all: true
- "edit note 1 to X" → intent: edit_note, note_number: 1, new_content: "X", edit_search_query: null
- "delete note 1" → intent: delete_note, note_number: 1
- "pin note 1" or "pin my note about X" → intent: pin_note, note_number: 1 or edit_search_query: "X", pin: true
- "unpin note 1" → intent: pin_note, note_number: 1, pin: false
- "make a checklist: milk, eggs" → intent: save_checklist, checklist_items: ["milk", "eggs"]
- "show topics" or "list my topics" → intent: show_topics
- "show notes about [topic]" → intent: show_list, topic_filter: "[topic]"
- "export my notes" or "send me all notes" → intent: export_notes
- "my timezone is X" or "I'm in X timezone" → intent: set_timezone, timezone_value: "X"
- "remind me every day/week/month" → set_reminder with recurrence: "daily"/"weekly"/"monthly"
- "mark all reminders done" or "clear all reminders" → intent: bulk_action, bulk_target: "reminders_today"
- "daily briefing" or "give me my briefing" → intent: answer_question, reply_message: trigger briefing
- If a note contains a specific future date/time, set smart_reminder_time to that ISO datetime
- Use conversation history below to resolve "yes", "that one", "it", "both", etc.
- note_number: set to integer (1, 2, 3...) when user refers to a note by its list position
- For edits: new_content = the replacement text, edit_search_query = keywords of the ORIGINAL note

Current datetime: ${now}
User timezone: ${userTimezone}
User rules: ${rulesText}`;

  // Build messages array with conversation context
  const messages = [{ role: 'system', content: systemPrompt }];
  if (Array.isArray(context) && context.length > 0) {
    messages.push(...context.slice(-8)); // last 4 turns (user+assistant pairs)
  }
  messages.push({ role: 'user', content: userMessage });

  const response = await fetch(`${GROQ_API_BASE}/chat/completions`, {
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

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq LLM failed: ${err}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '{}';

  try {
    return JSON.parse(content);
  } catch {
    console.error('Failed to parse LLM JSON:', content);
    return {
      intent: 'unclear',
      reply_message: "I'm not sure what you meant. Please try again."
    };
  }
}

export async function summarizeEntity(env, entityName, notesText) {
  const response = await fetch(`${GROQ_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'You are Chief, a personal AI assistant. Summarize the following notes about a person or project concisely.'
        },
        {
          role: 'user',
          content: `Summarize all notes about "${entityName}":\n\n${notesText}`
        }
      ],
      temperature: 0.3,
      max_tokens: 512
    })
  });

  if (!response.ok) {
    throw new Error('Groq summarization failed');
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || 'No summary available.';
}

export async function composeBriefing(env, { reminders, notes, entities }) {
  const context = [
    reminders?.length > 0 ? `Reminders today:\n${reminders.map(r => `- ${r.message} (due: ${new Date(r.due_at).toLocaleTimeString('en-IN')})`).join('\n')}` : '',
    notes?.length > 0 ? `Recent notes:\n${notes.map(n => `- ${n.content.substring(0, 80)}`).join('\n')}` : '',
    entities?.length > 0 ? `Open items:\n${entities.map(e => `- ${e.name} (${e.entity_type}): ${e.open_items} open items`).join('\n')}` : ''
  ].filter(Boolean).join('\n\n');

  if (!context) {
    return 'Good morning! No pending items for today.';
  }

  const response = await fetch(`${GROQ_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'You are Chief, a personal AI assistant. Compose a concise morning briefing based on the following data. Be friendly and structured.'
        },
        {
          role: 'user',
          content: `Compose morning briefing:\n\n${context}`
        }
      ],
      temperature: 0.4,
      max_tokens: 512
    })
  });

  if (!response.ok) {
    return `Good morning! Here's your briefing:\n\n${context}`;
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || `Good morning!\n\n${context}`;
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

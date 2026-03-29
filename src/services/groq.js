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

export async function getLLMResponse(env, userMessage, userRules) {
  const now = new Date().toISOString();
  const rulesText = userRules && userRules.length > 0
    ? userRules.map(r => r.rule_text).join('\n')
    : 'None';

  const systemPrompt = `You are Chief, a personal AI assistant. Analyze the user message and return ONLY valid JSON.

{
  "intent": "save_note|set_reminder|search_notes|show_list|mark_done|edit_note|delete_note|snooze|update_rule|query_entity|answer_question|unclear",
  "note_content": "cleaned note text if saving or new content if editing",
  "edit_search_query": "what to search for to find the note to edit or delete",
  "reminder_time_iso": "ISO8601 datetime if reminder, else null",
  "reminder_message": "reminder text if applicable",
  "search_query": "query string if searching",
  "entity_query": "person or project name if querying entity",
  "list_filter": "all|today|week|people|projects",
  "snooze_duration": "1h|tomorrow|null",
  "rule_text": "rule to save if updating rule",
  "delete_all": false,
  "people": ["array of people mentioned"],
  "projects": ["array of projects mentioned"],
  "topics": ["array of topics mentioned"],
  "tags": ["array of relevant tags"],
  "reply_message": "brief confirmation message to send user"
}

Current datetime: ${now}
User timezone: Asia/Kolkata
User rules: ${rulesText}`;

  const response = await fetch(`${GROQ_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
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
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

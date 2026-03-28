import { saveEpisode, getUserRules, saveNote, upsertEntities, saveReminder, searchNotes, listNotes, markNoteDone, markReminderDone, snoozeReminder, snoozeLatestReminder, saveUserRule, getEntity, getNotesByEntity, upsertUser } from '../services/supabase.js';
import { transcribeAudio, extractTextFromMedia, getLLMResponse, summarizeEntity } from '../services/groq.js';
import { generateEmbedding } from '../services/embeddings.js';
import { sendTextMessage, sendInteractiveButtons, downloadWhatsAppMedia } from '../services/whatsapp.js';
import { parseIntent } from '../utils/intent.js';
import { formatReminderTime } from '../utils/time.js';

export function verifyWebhook(request, env) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }

  return new Response('Forbidden', { status: 403 });
}

export async function receiveWebhook(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  // Acknowledge immediately
  const responsePromise = processWebhook(body, env);
  // Don't await - process in background
  responsePromise.catch(err => console.error('Background processing error:', err));

  return new Response('OK', { status: 200 });
}

async function processWebhook(body, env) {
  try {
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return;

    const message = messages[0];
    const userPhone = message.from;
    const messageType = message.type;

    // Ensure user exists
    await upsertUser(env, userPhone);

    // Handle interactive button replies
    if (messageType === 'interactive') {
      await handleInteractiveReply(message, userPhone, env);
      return;
    }

    // Step 1: Extract raw input
    let rawInput = '';
    let transcribedText = null;
    let inputType = messageType;

    if (messageType === 'text') {
      rawInput = message.text?.body || '';
    } else if (messageType === 'audio') {
      rawInput = message.audio?.id || '';
      inputType = 'voice';
    } else if (messageType === 'image') {
      rawInput = message.image?.id || '';
      inputType = 'image';
    } else if (messageType === 'document') {
      rawInput = message.document?.id || '';
      inputType = 'document';
    } else {
      return;
    }

    // Step 2: Save episode
    const episode = await saveEpisode(env, {
      user_phone: userPhone,
      raw_input: rawInput,
      input_type: inputType,
      transcribed_text: null
    });

    // Step 3: Handle audio transcription
    if (inputType === 'voice') {
      try {
        const mediaBuffer = await downloadWhatsAppMedia(env, rawInput);
        transcribedText = await transcribeAudio(env, mediaBuffer);
        rawInput = transcribedText;
        // Update episode with transcription
        await saveEpisode(env, {
          user_phone: userPhone,
          raw_input: rawInput,
          input_type: inputType,
          transcribed_text: transcribedText
        });
      } catch (err) {
        console.error('Audio transcription error:', err);
        await sendTextMessage(env, userPhone, "Couldn't process your voice message. Please try again.");
        return;
      }
    }

    // Step 4: Handle image/document
    if (inputType === 'image' || inputType === 'document') {
      try {
        const mediaBuffer = await downloadWhatsAppMedia(env, rawInput);
        transcribedText = await extractTextFromMedia(env, mediaBuffer, inputType);
        rawInput = transcribedText;
      } catch (err) {
        console.error('Media extraction error:', err);
        await sendTextMessage(env, userPhone, "Couldn't process your media file. Please try again.");
        return;
      }
    }

    if (!rawInput || rawInput.trim() === '') {
      await sendTextMessage(env, userPhone, "I couldn't understand that message. Please try again.");
      return;
    }

    // Step 5: Get user rules and send to LLM
    const userRules = await getUserRules(env, userPhone);
    const intentData = await getLLMResponse(env, rawInput, userRules);

    // Step 6: Execute intent handler
    await executeIntent(env, userPhone, intentData, rawInput);

  } catch (err) {
    console.error('processWebhook error:', err);
  }
}

async function handleInteractiveReply(message, userPhone, env) {
  try {
    const replyId = message.interactive?.button_reply?.id || '';

    if (replyId.startsWith('done_')) {
      const reminderId = replyId.replace('done_', '');
      await markReminderDone(env, reminderId);
      await sendTextMessage(env, userPhone, 'Marked as done!');
    } else if (replyId.startsWith('snooze1h_')) {
      const reminderId = replyId.replace('snooze1h_', '');
      const newTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await snoozeReminder(env, reminderId, newTime);
      await sendTextMessage(env, userPhone, 'Snoozed for 1 hour.');
    } else if (replyId.startsWith('snoozetomorrow_')) {
      const reminderId = replyId.replace('snoozetomorrow_', '');
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      await snoozeReminder(env, reminderId, tomorrow.toISOString());
      await sendTextMessage(env, userPhone, 'Snoozed until tomorrow at 9 AM.');
    }
  } catch (err) {
    console.error('handleInteractiveReply error:', err);
    await sendTextMessage(env, userPhone, 'Something went wrong, try again.');
  }
}

async function executeIntent(env, userPhone, intentData, rawInput) {
  const intent = intentData.intent || 'unclear';

  try {
    switch (intent) {
      case 'save_note':
        await handleSaveNote(env, userPhone, intentData);
        break;
      case 'set_reminder':
        await handleSetReminder(env, userPhone, intentData);
        break;
      case 'search_notes':
        await handleSearchNotes(env, userPhone, intentData);
        break;
      case 'show_list':
        await handleShowList(env, userPhone, intentData);
        break;
      case 'mark_done':
        await handleMarkDone(env, userPhone, intentData);
        break;
      case 'snooze':
        await handleSnooze(env, userPhone, intentData);
        break;
      case 'update_rule':
        await handleUpdateRule(env, userPhone, intentData);
        break;
      case 'query_entity':
        await handleQueryEntity(env, userPhone, intentData);
        break;
      case 'answer_question':
        await sendTextMessage(env, userPhone, intentData.reply_message || 'Here is your answer.');
        break;
      default:
        await sendTextMessage(env, userPhone, intentData.reply_message || "I'm not sure what you meant. Try rephrasing.");
    }
  } catch (err) {
    console.error(`executeIntent error for intent ${intent}:`, err);
    await sendTextMessage(env, userPhone, 'Something went wrong, try again.');
  }
}

async function handleSaveNote(env, userPhone, intentData) {
  const content = intentData.note_content || '';
  if (!content) {
    await sendTextMessage(env, userPhone, intentData.reply_message || 'Note saved.');
    return;
  }

  const embedding = await generateEmbedding(env, content);

  const note = await saveNote(env, {
    user_phone: userPhone,
    content,
    embedding,
    tags: intentData.tags || [],
    people: intentData.people || [],
    projects: intentData.projects || [],
    topics: intentData.topics || []
  });

  await upsertEntities(env, userPhone, {
    people: intentData.people || [],
    projects: intentData.projects || [],
    topics: intentData.topics || []
  });

  await sendTextMessage(env, userPhone, intentData.reply_message || 'Note saved!');
}

async function handleSetReminder(env, userPhone, intentData) {
  const content = intentData.note_content || intentData.reminder_message || '';
  let noteId = null;

  if (content) {
    const embedding = await generateEmbedding(env, content);
    const note = await saveNote(env, {
      user_phone: userPhone,
      content,
      embedding,
      tags: intentData.tags || [],
      people: intentData.people || [],
      projects: intentData.projects || [],
      topics: intentData.topics || []
    });

    await upsertEntities(env, userPhone, {
      people: intentData.people || [],
      projects: intentData.projects || [],
      topics: intentData.topics || []
    });

    noteId = note?.id || null;
  }

  const dueAt = intentData.reminder_time_iso;
  if (!dueAt) {
    await sendTextMessage(env, userPhone, "Couldn't parse reminder time. Please specify when to remind you.");
    return;
  }

  await saveReminder(env, {
    user_phone: userPhone,
    note_id: noteId,
    message: intentData.reminder_message || content,
    due_at: dueAt
  });

  const formattedTime = formatReminderTime(dueAt);
  await sendTextMessage(env, userPhone, intentData.reply_message || `Reminder set for ${formattedTime}.`);
}

async function handleSearchNotes(env, userPhone, intentData) {
  const query = intentData.search_query || '';
  if (!query) {
    await sendTextMessage(env, userPhone, 'What would you like to search for?');
    return;
  }

  const queryEmbedding = await generateEmbedding(env, query);
  const results = await searchNotes(env, userPhone, query, queryEmbedding);

  if (!results || results.length === 0) {
    await sendTextMessage(env, userPhone, 'No notes found matching your search.');
    return;
  }

  const formatted = results.map((note, i) => {
    const date = new Date(note.created_at).toLocaleDateString('en-IN');
    return `${i + 1}. ${note.content.substring(0, 100)}${note.content.length > 100 ? '...' : ''}\n   _${date}_`;
  }).join('\n\n');

  await sendTextMessage(env, userPhone, `*Search Results:*\n\n${formatted}`);
}

async function handleShowList(env, userPhone, intentData) {
  const filter = intentData.list_filter || 'all';
  const notes = await listNotes(env, userPhone, filter);

  if (!notes || notes.length === 0) {
    await sendTextMessage(env, userPhone, 'No notes found.');
    return;
  }

  const formatted = notes.map((note, i) => {
    const date = new Date(note.created_at).toLocaleDateString('en-IN');
    return `${i + 1}. ${note.content.substring(0, 80)}${note.content.length > 80 ? '...' : ''}\n   _${date}_`;
  }).join('\n\n');

  await sendTextMessage(env, userPhone, `*Your Notes:*\n\n${formatted}`);
}

async function handleMarkDone(env, userPhone, intentData) {
  const query = intentData.search_query || intentData.note_content || '';
  if (query) {
    const queryEmbedding = await generateEmbedding(env, query);
    const results = await searchNotes(env, userPhone, query, queryEmbedding);
    if (results && results.length > 0) {
      await markNoteDone(env, results[0].id);
      await sendTextMessage(env, userPhone, intentData.reply_message || 'Marked as done!');
      return;
    }
  }
  await sendTextMessage(env, userPhone, intentData.reply_message || 'Marked as done!');
}

async function handleSnooze(env, userPhone, intentData) {
  const duration = intentData.snooze_duration || '1h';
  let newTime;

  if (duration === 'tomorrow') {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    newTime = tomorrow.toISOString();
  } else {
    newTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  }

  await snoozeLatestReminder(env, userPhone, newTime);

  const msg = duration === 'tomorrow' ? 'Snoozed until tomorrow at 9 AM.' : 'Snoozed for 1 hour.';
  await sendTextMessage(env, userPhone, intentData.reply_message || msg);
}

async function handleUpdateRule(env, userPhone, intentData) {
  const ruleText = intentData.rule_text || '';
  if (!ruleText) {
    await sendTextMessage(env, userPhone, 'No rule text found.');
    return;
  }

  await saveUserRule(env, userPhone, ruleText);
  await sendTextMessage(env, userPhone, intentData.reply_message || 'Rule saved!');
}

async function handleQueryEntity(env, userPhone, intentData) {
  const entityName = intentData.entity_query || '';
  if (!entityName) {
    await sendTextMessage(env, userPhone, 'Which person or project would you like to know about?');
    return;
  }

  const entity = await getEntity(env, userPhone, entityName);
  const notes = await getNotesByEntity(env, userPhone, entityName);

  if (!notes || notes.length === 0) {
    await sendTextMessage(env, userPhone, `No notes found for "${entityName}".`);
    return;
  }

  const notesText = notes.map(n => n.content).join('\n\n');
  const summary = await summarizeEntity(env, entityName, notesText);

  await sendTextMessage(env, userPhone, `*${entityName}*\n\n${summary}`);
}


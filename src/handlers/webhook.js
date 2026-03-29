import { saveEpisode, getUserRules, saveNote, upsertEntities, saveReminder, searchNotes, listNotes, markNoteDone, markReminderDone, snoozeReminder, snoozeLatestReminder, saveUserRule, getEntity, getNotesByEntity, upsertUser } from '../services/supabase.js';
import { transcribeAudio, extractTextFromMedia, getLLMResponse, summarizeEntity } from '../services/groq.js';
import { generateEmbedding } from '../services/embeddings.js';
import { sendTextMessage, sendInteractiveButtons, answerCallbackQuery, downloadTelegramFile } from '../services/telegram.js';
import { formatReminderTime } from '../utils/time.js';

export async function receiveWebhook(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  // Process in background, respond immediately (Telegram requires fast 200)
  const processing = processUpdate(body, env);
  processing.catch(err => console.error('Background processing error:', err));

  return new Response('OK', { status: 200 });
}

async function processUpdate(body, env) {
  try {
    // Handle callback queries (button presses)
    if (body.callback_query) {
      await handleCallbackQuery(body.callback_query, env);
      return;
    }

    const message = body.message;
    if (!message) return;

    const chatId = message.chat.id.toString();
    const messageType = getMessageType(message);

    // Ensure user exists
    await upsertUser(env, chatId);

    // Extract raw input
    let rawInput = '';
    let inputType = messageType;
    let fileId = null;

    if (messageType === 'text') {
      rawInput = message.text || '';
    } else if (messageType === 'voice') {
      fileId = message.voice?.file_id;
      rawInput = fileId;
    } else if (messageType === 'audio') {
      fileId = message.audio?.file_id;
      rawInput = fileId;
      inputType = 'voice';
    } else if (messageType === 'image') {
      // Telegram sends array of photos, last = highest res
      const photos = message.photo;
      fileId = photos[photos.length - 1]?.file_id;
      rawInput = fileId;
    } else if (messageType === 'document') {
      fileId = message.document?.file_id;
      rawInput = fileId;
    } else {
      await sendTextMessage(env, chatId, "I can only process text, voice, images, and documents.");
      return;
    }

    // Save episode
    await saveEpisode(env, {
      user_phone: chatId,
      raw_input: rawInput,
      input_type: inputType,
      transcribed_text: null
    });

    // Handle voice transcription
    if (inputType === 'voice' && fileId) {
      try {
        const mediaBuffer = await downloadTelegramFile(env, fileId);
        rawInput = await transcribeAudio(env, mediaBuffer);
      } catch (err) {
        console.error('Audio transcription error:', err);
        await sendTextMessage(env, chatId, "Couldn't process your voice message. Please try again.");
        return;
      }
    }

    // Handle image/document text extraction
    if ((inputType === 'image' || inputType === 'document') && fileId) {
      try {
        const mediaBuffer = await downloadTelegramFile(env, fileId);
        rawInput = await extractTextFromMedia(env, mediaBuffer, inputType);
      } catch (err) {
        console.error('Media extraction error:', err);
        await sendTextMessage(env, chatId, "Couldn't process your file. Please try again.");
        return;
      }
    }

    if (!rawInput || rawInput.trim() === '') {
      await sendTextMessage(env, chatId, "I couldn't understand that message. Please try again.");
      return;
    }

    // Get user rules and send to LLM
    const userRules = await getUserRules(env, chatId);
    const intentData = await getLLMResponse(env, rawInput, userRules);

    // Execute intent
    await executeIntent(env, chatId, intentData);

  } catch (err) {
    console.error('processUpdate error:', err);
  }
}

function getMessageType(message) {
  if (message.text) return 'text';
  if (message.voice) return 'voice';
  if (message.audio) return 'audio';
  if (message.photo) return 'image';
  if (message.document) return 'document';
  return 'unknown';
}

async function handleCallbackQuery(callbackQuery, env) {
  const chatId = callbackQuery.from.id.toString();
  const data = callbackQuery.data || '';

  try {
    await answerCallbackQuery(env, callbackQuery.id);

    if (data.startsWith('done_')) {
      const reminderId = data.replace('done_', '');
      await markReminderDone(env, reminderId);
      await sendTextMessage(env, chatId, 'Marked as done!');
    } else if (data.startsWith('snooze1h_')) {
      const reminderId = data.replace('snooze1h_', '');
      const newTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await snoozeReminder(env, reminderId, newTime);
      await sendTextMessage(env, chatId, 'Snoozed for 1 hour.');
    } else if (data.startsWith('snoozetomorrow_')) {
      const reminderId = data.replace('snoozetomorrow_', '');
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      await snoozeReminder(env, reminderId, tomorrow.toISOString());
      await sendTextMessage(env, chatId, 'Snoozed until tomorrow at 9 AM.');
    }
  } catch (err) {
    console.error('handleCallbackQuery error:', err);
    await sendTextMessage(env, chatId, 'Something went wrong, try again.');
  }
}

async function executeIntent(env, chatId, intentData) {
  const intent = intentData.intent || 'unclear';

  try {
    switch (intent) {
      case 'save_note':
        await handleSaveNote(env, chatId, intentData);
        break;
      case 'set_reminder':
        await handleSetReminder(env, chatId, intentData);
        break;
      case 'search_notes':
        await handleSearchNotes(env, chatId, intentData);
        break;
      case 'show_list':
        await handleShowList(env, chatId, intentData);
        break;
      case 'mark_done':
        await handleMarkDone(env, chatId, intentData);
        break;
      case 'snooze':
        await handleSnooze(env, chatId, intentData);
        break;
      case 'update_rule':
        await handleUpdateRule(env, chatId, intentData);
        break;
      case 'query_entity':
        await handleQueryEntity(env, chatId, intentData);
        break;
      case 'answer_question':
        await sendTextMessage(env, chatId, intentData.reply_message || 'Here is your answer.');
        break;
      default:
        await sendTextMessage(env, chatId, intentData.reply_message || "I'm not sure what you meant. Try rephrasing.");
    }
  } catch (err) {
    console.error(`executeIntent error for intent ${intent}:`, err);
    await sendTextMessage(env, chatId, 'Something went wrong, try again.');
  }
}

async function handleSaveNote(env, chatId, intentData) {
  const content = intentData.note_content || '';
  if (!content) {
    await sendTextMessage(env, chatId, intentData.reply_message || 'Note saved.');
    return;
  }

  const embedding = await generateEmbedding(env, content);

  await saveNote(env, {
    user_phone: chatId,
    content,
    embedding,
    tags: intentData.tags || [],
    people: intentData.people || [],
    projects: intentData.projects || [],
    topics: intentData.topics || []
  });

  await upsertEntities(env, chatId, {
    people: intentData.people || [],
    projects: intentData.projects || [],
    topics: intentData.topics || []
  });

  await sendTextMessage(env, chatId, intentData.reply_message || 'Note saved!');
}

async function handleSetReminder(env, chatId, intentData) {
  const content = intentData.note_content || intentData.reminder_message || '';
  let noteId = null;

  if (content) {
    const embedding = await generateEmbedding(env, content);
    const note = await saveNote(env, {
      user_phone: chatId,
      content,
      embedding,
      tags: intentData.tags || [],
      people: intentData.people || [],
      projects: intentData.projects || [],
      topics: intentData.topics || []
    });

    await upsertEntities(env, chatId, {
      people: intentData.people || [],
      projects: intentData.projects || [],
      topics: intentData.topics || []
    });

    noteId = note?.id || null;
  }

  const dueAt = intentData.reminder_time_iso;
  if (!dueAt) {
    await sendTextMessage(env, chatId, "Couldn't parse the reminder time. Please specify when.");
    return;
  }

  await saveReminder(env, {
    user_phone: chatId,
    note_id: noteId,
    message: intentData.reminder_message || content,
    due_at: dueAt
  });

  const formattedTime = formatReminderTime(dueAt);
  await sendTextMessage(env, chatId, intentData.reply_message || `Reminder set for ${formattedTime}.`);
}

async function handleSearchNotes(env, chatId, intentData) {
  const query = intentData.search_query || '';
  if (!query) {
    await sendTextMessage(env, chatId, 'What would you like to search for?');
    return;
  }

  const queryEmbedding = await generateEmbedding(env, query);
  const results = await searchNotes(env, chatId, query, queryEmbedding);

  if (!results || results.length === 0) {
    await sendTextMessage(env, chatId, 'No notes found matching your search.');
    return;
  }

  const formatted = results.map((note, i) => {
    const date = new Date(note.created_at).toLocaleDateString('en-IN');
    return `${i + 1}. ${note.content.substring(0, 100)}${note.content.length > 100 ? '...' : ''}\n   _${date}_`;
  }).join('\n\n');

  await sendTextMessage(env, chatId, `*Search Results:*\n\n${formatted}`);
}

async function handleShowList(env, chatId, intentData) {
  const filter = intentData.list_filter || 'all';
  const notes = await listNotes(env, chatId, filter);

  if (!notes || notes.length === 0) {
    await sendTextMessage(env, chatId, 'No notes found.');
    return;
  }

  const formatted = notes.map((note, i) => {
    const date = new Date(note.created_at).toLocaleDateString('en-IN');
    return `${i + 1}. ${note.content.substring(0, 80)}${note.content.length > 80 ? '...' : ''}\n   _${date}_`;
  }).join('\n\n');

  await sendTextMessage(env, chatId, `*Your Notes:*\n\n${formatted}`);
}

async function handleMarkDone(env, chatId, intentData) {
  const query = intentData.search_query || intentData.note_content || '';
  if (query) {
    const queryEmbedding = await generateEmbedding(env, query);
    const results = await searchNotes(env, chatId, query, queryEmbedding);
    if (results && results.length > 0) {
      await markNoteDone(env, results[0].id);
    }
  }
  await sendTextMessage(env, chatId, intentData.reply_message || 'Marked as done!');
}

async function handleSnooze(env, chatId, intentData) {
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

  await snoozeLatestReminder(env, chatId, newTime);

  const msg = duration === 'tomorrow' ? 'Snoozed until tomorrow at 9 AM.' : 'Snoozed for 1 hour.';
  await sendTextMessage(env, chatId, intentData.reply_message || msg);
}

async function handleUpdateRule(env, chatId, intentData) {
  const ruleText = intentData.rule_text || '';
  if (!ruleText) {
    await sendTextMessage(env, chatId, 'No rule text found.');
    return;
  }
  await saveUserRule(env, chatId, ruleText);
  await sendTextMessage(env, chatId, intentData.reply_message || 'Rule saved!');
}

async function handleQueryEntity(env, chatId, intentData) {
  const entityName = intentData.entity_query || '';
  if (!entityName) {
    await sendTextMessage(env, chatId, 'Which person or project would you like to know about?');
    return;
  }

  const notes = await getNotesByEntity(env, chatId, entityName);

  if (!notes || notes.length === 0) {
    await sendTextMessage(env, chatId, `No notes found for "${entityName}".`);
    return;
  }

  const notesText = notes.map(n => n.content).join('\n\n');
  const summary = await summarizeEntity(env, entityName, notesText);

  await sendTextMessage(env, chatId, `*${entityName}*\n\n${summary}`);
}

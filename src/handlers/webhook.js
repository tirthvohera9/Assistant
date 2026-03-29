import { saveEpisode, updateEpisode, getUserRules, saveNote, upsertEntities, saveReminder, searchNotes, listNotes, markNoteDone, markReminderDone, snoozeReminder, snoozeLatestReminder, saveUserRule, getEntity, getNotesByEntity, upsertUser, updateNoteContent, deleteNote, deleteAllNotes } from '../services/supabase.js';
import { transcribeAudio, extractTextFromMedia, getLLMResponse, summarizeEntity } from '../services/groq.js';
import { generateEmbedding } from '../services/embeddings.js';
import { sendTextMessage, sendInteractiveButtons, answerCallbackQuery, downloadTelegramFile } from '../services/telegram.js';
import { formatReminderTime, parseSnoozeDuration, getTomorrowAt9AM, getOneHourFromNow } from '../utils/time.js';
import { parseIntent } from '../utils/intent.js';

const processedUpdates = new Set();

export async function receiveWebhook(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  const updateId = body?.update_id;
  if (updateId) {
    if (processedUpdates.has(updateId)) {
      return new Response('OK', { status: 200 });
    }
    processedUpdates.add(updateId);
    if (processedUpdates.size > 100) {
      const first = processedUpdates.values().next().value;
      processedUpdates.delete(first);
    }
  }

  ctx.waitUntil(processUpdate(body, env));

  return new Response('OK', { status: 200 });
}

async function processUpdate(body, env) {
  try {
    if (body.callback_query) {
      await handleCallbackQuery(body.callback_query, env);
      return;
    }

    const message = body.message;
    if (!message) return;

    const chatId = message.chat.id.toString();
    const messageType = getMessageType(message);

    // Parallelize: upsertUser + saveEpisode + getUserRules simultaneously
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

    // Run all independent setup calls in parallel
    const [, episode, userRules] = await Promise.all([
      upsertUser(env, chatId),
      saveEpisode(env, { user_phone: chatId, raw_input: rawInput, input_type: inputType, transcribed_text: null }),
      getUserRules(env, chatId)
    ]);

    // Handle media (must be sequential - need the buffer)
    if (inputType === 'voice' && fileId) {
      try {
        const mediaBuffer = await downloadTelegramFile(env, fileId);
        rawInput = await transcribeAudio(env, mediaBuffer);
        if (episode?.id) updateEpisode(env, episode.id, rawInput).catch(console.error);
      } catch (err) {
        console.error('Audio transcription error:', err);
        await sendTextMessage(env, chatId, "Couldn't process your voice message. Please try again.");
        return;
      }
    }

    if ((inputType === 'image' || inputType === 'document') && fileId) {
      try {
        const mediaBuffer = await downloadTelegramFile(env, fileId);
        rawInput = await extractTextFromMedia(env, mediaBuffer, inputType);
        if (episode?.id) updateEpisode(env, episode.id, rawInput).catch(console.error);
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

    // Handle Telegram bot commands directly
    if (messageType === 'text' && rawInput.startsWith('/')) {
      if (rawInput === '/start') {
        await sendTextMessage(env, chatId, `*Welcome to Chief!*\n\nI'm your personal AI assistant. Here's what I can do:\n\n*Notes*\n- "Save a note: meeting with John at 3pm"\n- "Show all my notes"\n- "Find my notes about the project"\n\n*Reminders*\n- "Remind me to call Sarah tomorrow at 9am"\n- "Snooze my reminder to tomorrow"\n\n*Edit & Delete*\n- "Edit my note about John, change it to..."\n- "Delete my note about the meeting"\n\n*People & Projects*\n- "What do I know about John?"\n\n*Voice & Images*\n- Send a voice message and I'll transcribe it\n- Send an image or PDF and I'll extract the text\n\n*Preferences*\n- "Always reply in bullet points" (custom rules)\n\nType /help anytime to see this again.`);
        return;
      }
      if (rawInput === '/help') {
        await sendTextMessage(env, chatId, `*Chief – Quick Reference*\n\n📝 *Save* – just tell me what to save\n🔔 *Remind* – "remind me to... at [time]"\n🔍 *Search* – "find my notes about..."\n📋 *List* – "show all notes" / "show today's notes"\n✅ *Done* – "mark [note] as done"\n✏️ *Edit* – "edit my note about [topic]"\n🗑 *Delete* – "delete my note about [topic]"\n👤 *Query* – "what do I know about [person/project]?"\n⏰ *Snooze* – "snooze my reminder" / "snooze to tomorrow"\n⚙️ *Rules* – "always reply in Hindi"`);
        return;
      }
    }

    // Parse and validate LLM intent
    const intentData = parseIntent(await getLLMResponse(env, rawInput, userRules));

    // Execute intent — reply fast, persist in background
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
      await Promise.all([
        markReminderDone(env, reminderId),
        sendTextMessage(env, chatId, 'Marked as done!')
      ]);
    } else if (data.startsWith('snooze1h_')) {
      const reminderId = data.replace('snooze1h_', '');
      await Promise.all([
        snoozeReminder(env, reminderId, getOneHourFromNow()),
        sendTextMessage(env, chatId, 'Snoozed for 1 hour.')
      ]);
    } else if (data.startsWith('snoozetomorrow_')) {
      const reminderId = data.replace('snoozetomorrow_', '');
      await Promise.all([
        snoozeReminder(env, reminderId, getTomorrowAt9AM()),
        sendTextMessage(env, chatId, 'Snoozed until tomorrow at 9 AM.')
      ]);
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
      case 'edit_note':
        await handleEditNote(env, chatId, intentData);
        break;
      case 'delete_note':
        await handleDeleteNote(env, chatId, intentData);
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

  // Reply immediately, persist in background
  await sendTextMessage(env, chatId, intentData.reply_message || 'Note saved!');

  // Background: embedding + DB write
  const embedding = await generateEmbedding(env, content);
  await Promise.all([
    saveNote(env, {
      user_phone: chatId,
      content,
      embedding,
      tags: intentData.tags || [],
      people: intentData.people || [],
      projects: intentData.projects || [],
      topics: intentData.topics || []
    }),
    upsertEntities(env, chatId, {
      people: intentData.people || [],
      projects: intentData.projects || [],
      topics: intentData.topics || []
    })
  ]);
}

async function handleSetReminder(env, chatId, intentData) {
  const content = intentData.note_content || intentData.reminder_message || '';
  const dueAt = intentData.reminder_time_iso;

  if (!dueAt) {
    await sendTextMessage(env, chatId, "Couldn't parse the reminder time. Please specify when.");
    return;
  }

  // Reply immediately
  const formattedTime = formatReminderTime(dueAt);
  await sendTextMessage(env, chatId, intentData.reply_message || `Reminder set for ${formattedTime}.`);

  // Background: save note + reminder
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

    await Promise.all([
      upsertEntities(env, chatId, {
        people: intentData.people || [],
        projects: intentData.projects || [],
        topics: intentData.topics || []
      }),
      saveReminder(env, {
        user_phone: chatId,
        note_id: note?.id || null,
        message: intentData.reminder_message || content,
        due_at: dueAt
      })
    ]);
  } else {
    await saveReminder(env, {
      user_phone: chatId,
      note_id: null,
      message: intentData.reminder_message || '',
      due_at: dueAt
    });
  }
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
  // Reply immediately
  await sendTextMessage(env, chatId, intentData.reply_message || 'Marked as done!');

  // Background: find and mark
  const query = intentData.search_query || intentData.note_content || '';
  if (query) {
    const queryEmbedding = await generateEmbedding(env, query);
    const results = await searchNotes(env, chatId, query, queryEmbedding);
    if (results && results.length > 0) {
      await markNoteDone(env, results[0].id);
    }
  }
}

async function handleSnooze(env, chatId, intentData) {
  const duration = intentData.snooze_duration || '1h';
  const newTime = parseSnoozeDuration(duration);
  const msg = duration === 'tomorrow' ? 'Snoozed until tomorrow at 9 AM.' : 'Snoozed for 1 hour.';

  await Promise.all([
    snoozeLatestReminder(env, chatId, newTime),
    sendTextMessage(env, chatId, intentData.reply_message || msg)
  ]);
}

async function handleUpdateRule(env, chatId, intentData) {
  const ruleText = intentData.rule_text || '';
  if (!ruleText) {
    await sendTextMessage(env, chatId, 'No rule text found.');
    return;
  }
  await Promise.all([
    saveUserRule(env, chatId, ruleText),
    sendTextMessage(env, chatId, intentData.reply_message || 'Rule saved!')
  ]);
}

async function handleEditNote(env, chatId, intentData) {
  const searchQuery = intentData.edit_search_query || intentData.note_content || '';
  const newContent = intentData.note_content || '';

  if (!searchQuery || !newContent) {
    await sendTextMessage(env, chatId, 'Please specify which note to edit and the new content.');
    return;
  }

  // Search first — don't send false success
  const queryEmbedding = await generateEmbedding(env, searchQuery);
  const results = await searchNotes(env, chatId, searchQuery, queryEmbedding);

  if (!results || results.length === 0) {
    await sendTextMessage(env, chatId, `Couldn't find a note matching "${searchQuery}".`);
    return;
  }

  // Found — reply and update in parallel
  const embedding = await generateEmbedding(env, newContent);
  await Promise.all([
    sendTextMessage(env, chatId, intentData.reply_message || 'Note updated!'),
    updateNoteContent(env, results[0].id, newContent, embedding)
  ]);
}

async function handleDeleteNote(env, chatId, intentData) {
  const deleteAll = intentData.delete_all === true;
  const searchQuery = intentData.edit_search_query || intentData.note_content || '';

  if (deleteAll) {
    await Promise.all([
      deleteAllNotes(env, chatId),
      sendTextMessage(env, chatId, intentData.reply_message || 'All notes deleted.')
    ]);
    return;
  }

  if (!searchQuery) {
    await sendTextMessage(env, chatId, 'Please specify which note to delete.');
    return;
  }

  // Search first — don't send false success
  const queryEmbedding = await generateEmbedding(env, searchQuery);
  const results = await searchNotes(env, chatId, searchQuery, queryEmbedding);

  if (!results || results.length === 0) {
    await sendTextMessage(env, chatId, `Couldn't find a note matching "${searchQuery}".`);
    return;
  }

  // Found — reply and soft-delete in parallel
  await Promise.all([
    sendTextMessage(env, chatId, intentData.reply_message || 'Note deleted.'),
    deleteNote(env, results[0].id)
  ]);
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

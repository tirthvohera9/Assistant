import { saveEpisode, updateEpisode, getUserRules, saveNote, upsertEntities, saveReminder, searchNotes, searchReminders, listNotes, markNoteDone, markReminderDone, snoozeReminder, snoozeLatestReminder, cancelReminder, saveUserRule, getEntity, getNotesByEntity, upsertUser, updateNoteContent, deleteNote, deleteAllNotes, updateNotePin, getNoteById, getUser, updateUserContext, updateUserTimezone, getAllTopics, listNotesByTopic, markAllRemindersDone } from '../services/supabase.js';
import { transcribeAudio, extractTextFromMedia } from '../services/groq.js';
import { getLLMResponse, summarizeEntity, composeBriefing } from '../services/openrouter.js';
import { generateEmbedding } from '../services/embeddings.js';
import { sendTextMessage, sendInteractiveButtons, sendConfirmButtons, answerCallbackQuery, downloadTelegramFile } from '../services/telegram.js';
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

    // Parallelize setup: upsertUser + saveEpisode + getUserRules + getUser
    const [, episode, userRules, user] = await Promise.all([
      upsertUser(env, chatId),
      saveEpisode(env, { user_phone: chatId, raw_input: rawInput, input_type: inputType, transcribed_text: null }),
      getUserRules(env, chatId),
      getUser(env, chatId)
    ]);

    const userTimezone = user?.timezone || 'Asia/Kolkata';
    const userContext = Array.isArray(user?.context) ? user.context : [];

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
        await sendTextMessage(env, chatId, `*Welcome to Chief!*\n\nI'm your personal AI assistant. Here's what I can do:\n\n*Notes*\n- "Save a note: meeting with John at 3pm"\n- "Show all my notes"\n- "Find my notes about the project"\n- "Make a checklist: milk, eggs, bread"\n- "Pin my note about budget"\n\n*Reminders*\n- "Remind me to call Sarah tomorrow at 9am"\n- "Remind me every Monday at 9am to review tasks"\n- "Snooze my reminder to tomorrow"\n\n*Edit & Delete*\n- "Edit note 1 to watch tennis instead"\n- "Delete my note about the meeting"\n\n*People & Projects*\n- "What do I know about John?"\n\n*Voice & Images*\n- Send a voice message and I'll transcribe it\n- Send an image or PDF and I'll extract the text\n\n*Settings*\n- "My timezone is America/New_York"\n- "Always reply in bullet points" (custom rules)\n\nType /help anytime to see this again.`);
        return;
      }
      if (rawInput === '/help') {
        await sendTextMessage(env, chatId, `*Chief – Quick Reference*\n\n📝 *Save* – just tell me what to save\n📋 *Checklist* – "make a checklist: item1, item2"\n📌 *Pin* – "pin note 1" or "pin my note about X"\n🔔 *Remind* – "remind me to... at [time]"\n🔁 *Recurring* – "remind me every day/week/month..."\n🔍 *Search* – "find my notes about..."\n📂 *Topics* – "show my topics" / "show notes about work"\n📋 *List* – "show all notes" / "show today's notes"\n✅ *Done* – "mark [note] as done"\n✏️ *Edit* – "edit note 1 to..."\n🗑 *Delete* – "delete note 1" or "delete all notes"\n👤 *Query* – "what do I know about [person/project]?"\n⏰ *Snooze* – "snooze my reminder" / "snooze to tomorrow"\n📤 *Export* – "export my notes"\n⚙️ *Rules* – "always reply in Hindi"\n🌍 *Timezone* – "my timezone is America/New_York"\n📊 *Briefing* – "give me today's briefing"`);
        return;
      }
    }

    // Parse intent with conversation context and user timezone
    const intentData = parseIntent(await getLLMResponse(env, rawInput, userRules, userContext, userTimezone));

    // Execute intent
    const replyMessage = await executeIntent(env, chatId, intentData);

    // Save conversation context (fire-and-forget)
    const assistantReply = replyMessage || intentData.reply_message || intentData.intent;
    if (assistantReply) {
      const newContext = [
        ...userContext,
        { role: 'user', content: rawInput },
        { role: 'assistant', content: assistantReply }
      ].slice(-10); // keep last 5 pairs
      updateUserContext(env, chatId, newContext).catch(console.error);
    }

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
    } else if (data === 'confirm_delete_all') {
      await deleteAllNotes(env, chatId);
      await sendTextMessage(env, chatId, 'All notes deleted.');
    } else if (data === 'cancel_delete_all') {
      await sendTextMessage(env, chatId, 'Cancelled. Your notes are safe.');
    } else if (data.startsWith('srem_')) {
      // Smart reminder: srem_{noteId}_{unixSeconds}
      const parts = data.split('_');
      if (parts.length >= 3) {
        const noteId = parts[1];
        const timestamp = parseInt(parts[2]) * 1000;
        const dueAt = new Date(timestamp).toISOString();
        const note = await getNoteById(env, noteId);
        const message = note?.content?.substring(0, 100) || 'Reminder';
        await saveReminder(env, { user_phone: chatId, message, due_at: dueAt });
        await sendTextMessage(env, chatId, `Reminder set for ${formatReminderTime(dueAt)}.`);
      }
    }
  } catch (err) {
    console.error('handleCallbackQuery error:', err);
    await sendTextMessage(env, chatId, 'Something went wrong, try again.');
  }
}

// Returns the reply text for context saving
async function executeIntent(env, chatId, intentData) {
  const intent = intentData.intent || 'unclear';

  try {
    switch (intent) {
      case 'save_note':
        return await handleSaveNote(env, chatId, intentData);
      case 'save_checklist':
        return await handleSaveChecklist(env, chatId, intentData);
      case 'set_reminder':
        return await handleSetReminder(env, chatId, intentData);
      case 'search_notes':
        return await handleSearchNotes(env, chatId, intentData);
      case 'show_list':
        return await handleShowList(env, chatId, intentData);
      case 'show_topics':
        return await handleShowTopics(env, chatId, intentData);
      case 'mark_done':
        return await handleMarkDone(env, chatId, intentData);
      case 'snooze':
        return await handleSnooze(env, chatId, intentData);
      case 'edit_note':
        return await handleEditNote(env, chatId, intentData);
      case 'delete_note':
        return await handleDeleteNote(env, chatId, intentData);
      case 'delete_reminder':
        return await handleDeleteReminder(env, chatId, intentData);
      case 'update_rule':
        return await handleUpdateRule(env, chatId, intentData);
      case 'query_entity':
        return await handleQueryEntity(env, chatId, intentData);
      case 'pin_note':
        return await handlePinNote(env, chatId, intentData);
      case 'export_notes':
        return await handleExportNotes(env, chatId, intentData);
      case 'set_timezone':
        return await handleSetTimezone(env, chatId, intentData);
      case 'bulk_action':
        return await handleBulkAction(env, chatId, intentData);
      case 'answer_question': {
        // Check if user is asking for their briefing on demand
        const msg = intentData.reply_message || '';
        if (/briefing|summary|today/i.test(msg)) {
          return await handleOnDemandBriefing(env, chatId);
        }
        const reply = intentData.reply_message || 'Here is your answer.';
        await sendTextMessage(env, chatId, reply);
        return reply;
      }
      default: {
        const reply = intentData.reply_message || "I'm not sure what you meant. Try rephrasing.";
        await sendTextMessage(env, chatId, reply);
        return reply;
      }
    }
  } catch (err) {
    console.error(`executeIntent error for intent ${intent}:`, err);
    await sendTextMessage(env, chatId, 'Something went wrong, try again.');
    return null;
  }
}

async function handleSaveNote(env, chatId, intentData) {
  const content = intentData.note_content || '';
  if (!content) {
    const reply = intentData.reply_message || 'Note saved.';
    await sendTextMessage(env, chatId, reply);
    return reply;
  }

  // Reply immediately
  const reply = intentData.reply_message || 'Note saved!';
  await sendTextMessage(env, chatId, reply);

  // Background: embedding + DB write
  const embedding = await generateEmbedding(env, content);
  const [note] = await Promise.all([
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

  // Feature 8: smart reminder suggestion
  if (intentData.smart_reminder_time && note?.id) {
    const ts = Math.floor(new Date(intentData.smart_reminder_time).getTime() / 1000);
    const callbackData = `srem_${note.id}_${ts}`;
    if (callbackData.length <= 64) {
      const formattedTime = formatReminderTime(intentData.smart_reminder_time);
      await sendInteractiveButtonsGeneric(env, chatId,
        `I noticed a date in your note. Set a reminder for *${formattedTime}*?`,
        [{ text: `Remind me ${formattedTime}`, callback_data: callbackData }]
      );
    }
  }

  return reply;
}

async function handleSaveChecklist(env, chatId, intentData) {
  const items = intentData.checklist_items || [];
  if (items.length === 0) {
    await sendTextMessage(env, chatId, 'What items should be on the checklist?');
    return null;
  }

  const content = items.map(item => `- [ ] ${item}`).join('\n');
  const reply = intentData.reply_message || `Checklist saved with ${items.length} item${items.length > 1 ? 's' : ''}!`;
  await sendTextMessage(env, chatId, reply);

  const embedding = await generateEmbedding(env, content);
  await saveNote(env, {
    user_phone: chatId,
    content,
    embedding,
    tags: ['checklist', ...(intentData.tags || [])],
    people: intentData.people || [],
    projects: intentData.projects || [],
    topics: intentData.topics || []
  });

  return reply;
}

async function handleSetReminder(env, chatId, intentData) {
  const content = intentData.note_content || intentData.reminder_message || '';
  const dueAt = intentData.reminder_time_iso;

  if (!dueAt) {
    await sendTextMessage(env, chatId, "Couldn't parse the reminder time. Please specify when.");
    return null;
  }

  const formattedTime = formatReminderTime(dueAt);
  const recurrence = intentData.recurrence || 'none';
  const recurrenceLabel = recurrence !== 'none' ? ` (repeats ${recurrence})` : '';
  const reply = intentData.reply_message || `Reminder set for ${formattedTime}${recurrenceLabel}.`;
  await sendTextMessage(env, chatId, reply);

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
        due_at: dueAt,
        recurrence
      })
    ]);
  } else {
    await saveReminder(env, {
      user_phone: chatId,
      note_id: null,
      message: intentData.reminder_message || '',
      due_at: dueAt,
      recurrence
    });
  }

  return reply;
}

async function handleSearchNotes(env, chatId, intentData) {
  const query = intentData.search_query || '';
  if (!query) {
    await sendTextMessage(env, chatId, 'What would you like to search for?');
    return null;
  }

  const queryEmbedding = await generateEmbedding(env, query);
  const results = await searchNotes(env, chatId, query, queryEmbedding);

  if (!results || results.length === 0) {
    const reply = 'No notes found matching your search.';
    await sendTextMessage(env, chatId, reply);
    return reply;
  }

  const formatted = results.map((note, i) => {
    const date = new Date(note.created_at).toLocaleDateString('en-IN');
    const pin = note.pinned ? '📌 ' : '';
    return `${i + 1}. ${pin}${note.content.substring(0, 100)}${note.content.length > 100 ? '...' : ''}\n   _${date}_`;
  }).join('\n\n');

  const reply = `*Search Results:*\n\n${formatted}`;
  await sendTextMessage(env, chatId, reply);
  return reply;
}

async function handleShowList(env, chatId, intentData) {
  // Feature 2: filter by topic
  if (intentData.topic_filter) {
    return await handleShowNotesByTopic(env, chatId, intentData.topic_filter);
  }

  const filter = intentData.list_filter || 'all';
  const notes = await listNotes(env, chatId, filter);

  if (!notes || notes.length === 0) {
    const reply = 'No notes found.';
    await sendTextMessage(env, chatId, reply);
    return reply;
  }

  const formatted = notes.map((note, i) => {
    const date = new Date(note.created_at).toLocaleDateString('en-IN');
    const pin = note.pinned ? '📌 ' : '';
    return `${i + 1}. ${pin}${note.content.substring(0, 80)}${note.content.length > 80 ? '...' : ''}\n   _${date}_`;
  }).join('\n\n');

  const reply = `*Your Notes:*\n\n${formatted}`;
  await sendTextMessage(env, chatId, reply);
  return reply;
}

async function handleShowNotesByTopic(env, chatId, topic) {
  const notes = await listNotesByTopic(env, chatId, topic);

  if (!notes || notes.length === 0) {
    const reply = `No notes found for topic *${topic}*.`;
    await sendTextMessage(env, chatId, reply);
    return reply;
  }

  const formatted = notes.map((note, i) => {
    const date = new Date(note.created_at).toLocaleDateString('en-IN');
    const pin = note.pinned ? '📌 ' : '';
    return `${i + 1}. ${pin}${note.content.substring(0, 80)}${note.content.length > 80 ? '...' : ''}\n   _${date}_`;
  }).join('\n\n');

  const reply = `*Notes about "${topic}":*\n\n${formatted}`;
  await sendTextMessage(env, chatId, reply);
  return reply;
}

async function handleShowTopics(env, chatId, intentData) {
  const topics = await getAllTopics(env, chatId);

  if (!topics || topics.length === 0) {
    const reply = "You don't have any topics yet. Topics are created automatically when you save notes.";
    await sendTextMessage(env, chatId, reply);
    return reply;
  }

  const formatted = topics.map(t => `• ${t}`).join('\n');
  const reply = `*Your Topics:*\n\n${formatted}\n\nTry: "show notes about [topic name]"`;
  await sendTextMessage(env, chatId, reply);
  return reply;
}

async function handleMarkDone(env, chatId, intentData) {
  const reply = intentData.reply_message || 'Marked as done!';
  await sendTextMessage(env, chatId, reply);

  const query = intentData.search_query || intentData.note_content || '';
  if (query) {
    const queryEmbedding = await generateEmbedding(env, query);
    const results = await searchNotes(env, chatId, query, queryEmbedding);
    if (results && results.length > 0) {
      await markNoteDone(env, results[0].id);
    }
  }

  return reply;
}

async function handleSnooze(env, chatId, intentData) {
  const duration = intentData.snooze_duration || '1h';
  const searchQuery = intentData.snooze_search_query || '';
  const newTime = parseSnoozeDuration(duration);
  const msg = duration === 'tomorrow' ? 'Snoozed until tomorrow at 9 AM.' : 'Snoozed for 1 hour.';

  if (searchQuery) {
    const results = await searchReminders(env, chatId, searchQuery);
    if (!results || results.length === 0) {
      await sendTextMessage(env, chatId, `Couldn't find a pending reminder matching "${searchQuery}".`);
      return null;
    }
    const reply = intentData.reply_message || msg;
    await Promise.all([
      snoozeReminder(env, results[0].id, newTime),
      sendTextMessage(env, chatId, reply)
    ]);
    return reply;
  } else {
    const reply = intentData.reply_message || msg;
    await Promise.all([
      snoozeLatestReminder(env, chatId, newTime),
      sendTextMessage(env, chatId, reply)
    ]);
    return reply;
  }
}

async function handleEditNote(env, chatId, intentData) {
  const newContent = intentData.new_content || intentData.note_content || '';
  const searchQuery = intentData.edit_search_query || '';
  const noteNumber = intentData.note_number;

  if (!newContent) {
    await sendTextMessage(env, chatId, 'What should the note say after editing?');
    return null;
  }

  let targetNote = null;

  if (noteNumber && noteNumber > 0) {
    const notes = await listNotes(env, chatId, 'all');
    targetNote = notes[noteNumber - 1] || null;
    if (!targetNote) {
      await sendTextMessage(env, chatId, `There is no note #${noteNumber}.`);
      return null;
    }
  } else if (searchQuery) {
    const queryEmbedding = await generateEmbedding(env, searchQuery);
    const results = await searchNotes(env, chatId, searchQuery, queryEmbedding);
    if (!results || results.length === 0) {
      await sendTextMessage(env, chatId, `Couldn't find a note matching "${searchQuery}".`);
      return null;
    }
    targetNote = results[0];
  } else {
    await sendTextMessage(env, chatId, 'Please specify which note to edit (e.g. "edit note 1 to...").');
    return null;
  }

  const embedding = await generateEmbedding(env, newContent);
  await updateNoteContent(env, targetNote.id, newContent, embedding);
  const reply = intentData.reply_message || 'Note updated!';
  await sendTextMessage(env, chatId, reply);
  return reply;
}

async function handleDeleteNote(env, chatId, intentData) {
  const deleteAll = intentData.delete_all === true;
  const searchQuery = intentData.edit_search_query || '';
  const noteNumber = intentData.note_number;

  if (deleteAll) {
    await sendConfirmButtons(env, chatId, 'Are you sure you want to delete ALL notes? This cannot be undone.', 'confirm_delete_all', 'cancel_delete_all');
    return 'Confirm: delete all notes?';
  }

  let targetNote = null;

  if (noteNumber && noteNumber > 0) {
    const notes = await listNotes(env, chatId, 'all');
    targetNote = notes[noteNumber - 1] || null;
    if (!targetNote) {
      await sendTextMessage(env, chatId, `There is no note #${noteNumber}.`);
      return null;
    }
  } else if (searchQuery) {
    const queryEmbedding = await generateEmbedding(env, searchQuery);
    const results = await searchNotes(env, chatId, searchQuery, queryEmbedding);
    if (!results || results.length === 0) {
      await sendTextMessage(env, chatId, `Couldn't find a note matching "${searchQuery}".`);
      return null;
    }
    targetNote = results[0];
  } else {
    await sendTextMessage(env, chatId, 'Please specify which note to delete.');
    return null;
  }

  await deleteNote(env, targetNote.id);
  const reply = intentData.reply_message || 'Note deleted.';
  await sendTextMessage(env, chatId, reply);
  return reply;
}

async function handleDeleteReminder(env, chatId, intentData) {
  const searchQuery = intentData.edit_search_query || '';

  if (!searchQuery) {
    await sendTextMessage(env, chatId, 'Which reminder would you like to cancel?');
    return null;
  }

  const results = await searchReminders(env, chatId, searchQuery);

  if (!results || results.length === 0) {
    await sendTextMessage(env, chatId, `Couldn't find a pending reminder matching "${searchQuery}".`);
    return null;
  }

  await Promise.all([
    cancelReminder(env, results[0].id),
    sendTextMessage(env, chatId, intentData.reply_message || 'Reminder cancelled.')
  ]);
  return intentData.reply_message || 'Reminder cancelled.';
}

async function handleUpdateRule(env, chatId, intentData) {
  const ruleText = intentData.rule_text || '';
  if (!ruleText) {
    await sendTextMessage(env, chatId, 'No rule text found.');
    return null;
  }
  const reply = intentData.reply_message || 'Rule saved!';
  await Promise.all([
    saveUserRule(env, chatId, ruleText),
    sendTextMessage(env, chatId, reply)
  ]);
  return reply;
}

async function handleQueryEntity(env, chatId, intentData) {
  const entityName = intentData.entity_query || '';
  if (!entityName) {
    await sendTextMessage(env, chatId, 'Which person or project would you like to know about?');
    return null;
  }

  const notes = await getNotesByEntity(env, chatId, entityName);

  if (!notes || notes.length === 0) {
    const reply = `No notes found for "${entityName}".`;
    await sendTextMessage(env, chatId, reply);
    return reply;
  }

  const notesText = notes.map(n => n.content).join('\n\n');
  const summary = await summarizeEntity(env, entityName, notesText);

  const reply = `*${entityName}*\n\n${summary}`;
  await sendTextMessage(env, chatId, reply);
  return reply;
}

// Feature 3: Pin/unpin notes
async function handlePinNote(env, chatId, intentData) {
  const pinned = intentData.pin !== false; // default true
  const searchQuery = intentData.edit_search_query || '';
  const noteNumber = intentData.note_number;

  let targetNote = null;

  if (noteNumber && noteNumber > 0) {
    const notes = await listNotes(env, chatId, 'all');
    targetNote = notes[noteNumber - 1] || null;
    if (!targetNote) {
      await sendTextMessage(env, chatId, `There is no note #${noteNumber}.`);
      return null;
    }
  } else if (searchQuery) {
    const queryEmbedding = await generateEmbedding(env, searchQuery);
    const results = await searchNotes(env, chatId, searchQuery, queryEmbedding);
    if (!results || results.length === 0) {
      await sendTextMessage(env, chatId, `Couldn't find a note matching "${searchQuery}".`);
      return null;
    }
    targetNote = results[0];
  } else {
    await sendTextMessage(env, chatId, 'Please specify which note to pin.');
    return null;
  }

  await updateNotePin(env, targetNote.id, pinned);
  const action = pinned ? 'pinned' : 'unpinned';
  const reply = intentData.reply_message || `Note ${action}! Pinned notes always appear at the top of your list.`;
  await sendTextMessage(env, chatId, reply);
  return reply;
}

// Feature 7: Export all notes
async function handleExportNotes(env, chatId, intentData) {
  const filter = intentData.list_filter || 'all';
  const notes = await listNotes(env, chatId, filter);

  if (!notes || notes.length === 0) {
    const reply = 'No notes to export.';
    await sendTextMessage(env, chatId, reply);
    return reply;
  }

  const chunks = [];
  let current = `*Your Notes (${notes.length} total):*\n\n`;

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const date = new Date(note.created_at).toLocaleDateString('en-IN');
    const pin = note.pinned ? '📌 ' : '';
    const line = `${i + 1}. ${pin}${note.content}\n   _${date}_\n\n`;

    if (current.length + line.length > 3800) {
      chunks.push(current.trim());
      current = line;
    } else {
      current += line;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  for (const chunk of chunks) {
    await sendTextMessage(env, chatId, chunk);
  }

  return `Exported ${notes.length} notes.`;
}

// Feature 9: Set timezone
async function handleSetTimezone(env, chatId, intentData) {
  const timezone = intentData.timezone_value || '';
  if (!timezone) {
    await sendTextMessage(env, chatId, 'Please specify a timezone (e.g. "my timezone is America/New_York").');
    return null;
  }

  await updateUserTimezone(env, chatId, timezone);
  const reply = intentData.reply_message || `Timezone set to *${timezone}*. I'll use this for all your reminders.`;
  await sendTextMessage(env, chatId, reply);
  return reply;
}

// Feature 6: Bulk actions
async function handleBulkAction(env, chatId, intentData) {
  const target = intentData.bulk_target || '';

  if (target === 'reminders_today') {
    await markAllRemindersDone(env, chatId);
    const reply = intentData.reply_message || 'All pending reminders marked as done!';
    await sendTextMessage(env, chatId, reply);
    return reply;
  }

  const reply = intentData.reply_message || "I'm not sure what you'd like to do in bulk. Try: \"mark all reminders done\"";
  await sendTextMessage(env, chatId, reply);
  return reply;
}

// Feature 11: On-demand briefing
async function handleOnDemandBriefing(env, chatId) {
  const { getUserRemindersToday, getActiveNotesToday, getTopEntities } = await import('../services/supabase.js');

  const [todaysReminders, activeNotes, topEntities] = await Promise.all([
    getUserRemindersToday(env, chatId),
    getActiveNotesToday(env, chatId),
    getTopEntities(env, chatId)
  ]);

  const briefingText = await composeBriefing(env, {
    reminders: todaysReminders,
    notes: activeNotes,
    entities: topEntities
  });

  await sendTextMessage(env, chatId, briefingText);
  return briefingText;
}

// Helper for custom inline keyboard buttons
async function sendInteractiveButtonsGeneric(env, chatId, message, buttons) {
  const { sendTextMessage: send } = await import('../services/telegram.js');
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [buttons]
      }
    })
  });
  if (!response.ok) {
    console.error('sendInteractiveButtonsGeneric failed:', await response.text());
  }
}

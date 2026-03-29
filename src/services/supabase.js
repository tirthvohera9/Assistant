function getHeaders(env) {
  return {
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
}

async function supabaseRequest(env, method, path, body = null) {
  const url = `${env.SUPABASE_URL}/rest/v1${path}`;
  const options = {
    method,
    headers: getHeaders(env)
  };

  if (body !== null) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Supabase error [${method} ${path}]: ${err}`);
  }

  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function upsertUser(env, phone) {
  try {
    await supabaseRequest(env, 'POST', '/users', {
      phone,
      briefing_time: '07:30',
      timezone: 'Asia/Kolkata'
    });
  } catch {
    // User may already exist, ignore conflict
  }
}

export async function saveEpisode(env, data) {
  try {
    const result = await supabaseRequest(env, 'POST', '/episodes', data);
    return Array.isArray(result) ? result[0] : result;
  } catch (err) {
    console.error('saveEpisode error:', err);
    return null;
  }
}

export async function getUserRules(env, userPhone) {
  try {
    const result = await supabaseRequest(env, 'GET', `/user_rules?user_phone=eq.${encodeURIComponent(userPhone)}&order=created_at.desc`);
    return result || [];
  } catch (err) {
    console.error('getUserRules error:', err);
    return [];
  }
}

export async function saveNote(env, data) {
  try {
    const payload = {
      user_phone: data.user_phone,
      content: data.content,
      tags: data.tags || [],
      people: data.people || [],
      projects: data.projects || [],
      topics: data.topics || [],
      status: 'active'
    };

    if (data.embedding) {
      payload.embedding = JSON.stringify(data.embedding);
    }

    const result = await supabaseRequest(env, 'POST', '/notes', payload);
    return Array.isArray(result) ? result[0] : result;
  } catch (err) {
    console.error('saveNote error:', err);
    return null;
  }
}

export async function upsertEntities(env, userPhone, { people = [], projects = [], topics = [] }) {
  const allEntities = [
    ...people.map(name => ({ entity_type: 'person', name })),
    ...projects.map(name => ({ entity_type: 'project', name })),
    ...topics.map(name => ({ entity_type: 'topic', name }))
  ];

  for (const entity of allEntities) {
    if (!entity.name) continue;
    try {
      await supabaseRequest(env, 'POST', '/entities', {
        user_phone: userPhone,
        entity_type: entity.entity_type,
        name: entity.name,
        last_mentioned: new Date().toISOString(),
        open_items: 1,
        metadata: {}
      });
    } catch {
      // Try update if insert fails (conflict on unique constraint)
      try {
        await supabaseRequest(
          env,
          'PATCH',
          `/entities?user_phone=eq.${encodeURIComponent(userPhone)}&entity_type=eq.${entity.entity_type}&name=eq.${encodeURIComponent(entity.name)}`,
          {
            last_mentioned: new Date().toISOString()
          }
        );
      } catch (updateErr) {
        console.error('upsertEntities update error:', updateErr);
      }
    }
  }
}

export async function saveReminder(env, data) {
  try {
    const payload = {
      user_phone: data.user_phone,
      message: data.message,
      due_at: data.due_at,
      status: 'pending'
    };

    if (data.note_id) {
      payload.note_id = data.note_id;
    }

    const result = await supabaseRequest(env, 'POST', '/reminders', payload);
    return Array.isArray(result) ? result[0] : result;
  } catch (err) {
    console.error('saveReminder error:', err);
    return null;
  }
}

export async function searchNotes(env, userPhone, query, queryEmbedding) {
  const results = new Map();

  // Vector similarity search via RPC
  if (queryEmbedding) {
    try {
      const vectorResults = await supabaseRequest(env, 'POST', '/rpc/search_notes_by_embedding', {
        p_user_phone: userPhone,
        p_embedding: JSON.stringify(queryEmbedding),
        p_limit: 5
      });
      if (Array.isArray(vectorResults)) {
        vectorResults.forEach(note => results.set(note.id, note));
      }
    } catch (err) {
      console.error('Vector search error:', err);
    }
  }

  // Full text search fallback
  try {
    const textResults = await supabaseRequest(
      env,
      'GET',
      `/notes?user_phone=eq.${encodeURIComponent(userPhone)}&content=ilike.*${encodeURIComponent(query)}*&status=eq.active&order=created_at.desc&limit=5`
    );
    if (Array.isArray(textResults)) {
      textResults.forEach(note => results.set(note.id, note));
    }
  } catch (err) {
    console.error('Text search error:', err);
  }

  // Sort by created_at descending
  return Array.from(results.values())
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 5);
}

export async function listNotes(env, userPhone, filter = 'all') {
  try {
    let queryParams = `user_phone=eq.${encodeURIComponent(userPhone)}&status=eq.active&order=created_at.desc`;

    if (filter === 'today') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      queryParams += `&created_at=gte.${today.toISOString()}`;
    } else if (filter === 'week') {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      queryParams += `&created_at=gte.${weekAgo.toISOString()}`;
    }

    queryParams += '&limit=20';

    const result = await supabaseRequest(env, 'GET', `/notes?${queryParams}`);
    return result || [];
  } catch (err) {
    console.error('listNotes error:', err);
    return [];
  }
}

export async function markNoteDone(env, noteId) {
  try {
    await supabaseRequest(
      env,
      'PATCH',
      `/notes?id=eq.${noteId}`,
      { status: 'done', updated_at: new Date().toISOString() }
    );
  } catch (err) {
    console.error('markNoteDone error:', err);
  }
}

export async function updateNoteContent(env, noteId, newContent, embedding) {
  try {
    const payload = {
      content: newContent,
      updated_at: new Date().toISOString()
    };
    if (embedding) {
      payload.embedding = JSON.stringify(embedding);
    }
    await supabaseRequest(env, 'PATCH', `/notes?id=eq.${noteId}`, payload);
  } catch (err) {
    console.error('updateNoteContent error:', err);
  }
}

export async function deleteNote(env, noteId) {
  try {
    await supabaseRequest(env, 'PATCH', `/notes?id=eq.${noteId}`, {
      status: 'archived',
      updated_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('deleteNote error:', err);
  }
}

export async function deleteAllNotes(env, userPhone) {
  try {
    await supabaseRequest(env, 'PATCH', `/notes?user_phone=eq.${encodeURIComponent(userPhone)}&status=eq.active`, {
      status: 'archived',
      updated_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('deleteAllNotes error:', err);
  }
}

export async function markReminderDone(env, reminderId) {
  try {
    await supabaseRequest(
      env,
      'PATCH',
      `/reminders?id=eq.${reminderId}`,
      { status: 'done' }
    );
  } catch (err) {
    console.error('markReminderDone error:', err);
  }
}

export async function snoozeReminder(env, reminderId, newTime) {
  try {
    await supabaseRequest(
      env,
      'PATCH',
      `/reminders?id=eq.${reminderId}`,
      { status: 'pending', due_at: newTime }
    );
  } catch (err) {
    console.error('snoozeReminder error:', err);
  }
}

export async function snoozeLatestReminder(env, userPhone, newTime) {
  try {
    const reminders = await supabaseRequest(
      env,
      'GET',
      `/reminders?user_phone=eq.${encodeURIComponent(userPhone)}&status=eq.pending&order=due_at.asc&limit=1`
    );

    if (reminders && reminders.length > 0) {
      await snoozeReminder(env, reminders[0].id, newTime);
      return reminders[0];
    }
    return null;
  } catch (err) {
    console.error('snoozeLatestReminder error:', err);
    return null;
  }
}

export async function saveUserRule(env, userPhone, ruleText) {
  try {
    await supabaseRequest(env, 'POST', '/user_rules', {
      user_phone: userPhone,
      rule_text: ruleText
    });
  } catch (err) {
    console.error('saveUserRule error:', err);
  }
}

export async function getEntity(env, userPhone, name) {
  try {
    const result = await supabaseRequest(
      env,
      'GET',
      `/entities?user_phone=eq.${encodeURIComponent(userPhone)}&name=ilike.${encodeURIComponent(name)}&limit=1`
    );
    return result?.[0] || null;
  } catch (err) {
    console.error('getEntity error:', err);
    return null;
  }
}

export async function getNotesByEntity(env, userPhone, name) {
  try {
    // Search in people, projects, and topics arrays
    const encoded = encodeURIComponent(name);
    const [byPeople, byProjects, byTopics] = await Promise.all([
      supabaseRequest(env, 'GET', `/notes?user_phone=eq.${encodeURIComponent(userPhone)}&people=cs.{${encoded}}&status=eq.active&order=created_at.desc&limit=10`).catch(() => []),
      supabaseRequest(env, 'GET', `/notes?user_phone=eq.${encodeURIComponent(userPhone)}&projects=cs.{${encoded}}&status=eq.active&order=created_at.desc&limit=10`).catch(() => []),
      supabaseRequest(env, 'GET', `/notes?user_phone=eq.${encodeURIComponent(userPhone)}&topics=cs.{${encoded}}&status=eq.active&order=created_at.desc&limit=10`).catch(() => [])
    ]);

    const all = new Map();
    [...(byPeople || []), ...(byProjects || []), ...(byTopics || [])].forEach(n => all.set(n.id, n));
    return Array.from(all.values()).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 10);
  } catch (err) {
    console.error('getNotesByEntity error:', err);
    return [];
  }
}

export async function getDueReminders(env) {
  try {
    const now = new Date().toISOString();
    const result = await supabaseRequest(
      env,
      'GET',
      `/reminders?status=eq.pending&due_at=lte.${now}&order=due_at.asc&limit=50`
    );
    return result || [];
  } catch (err) {
    console.error('getDueReminders error:', err);
    return [];
  }
}

export async function updateReminderStatus(env, reminderId, status) {
  try {
    await supabaseRequest(
      env,
      'PATCH',
      `/reminders?id=eq.${reminderId}`,
      { status }
    );
  } catch (err) {
    console.error('updateReminderStatus error:', err);
  }
}

export async function getAllUsers(env) {
  try {
    const result = await supabaseRequest(env, 'GET', '/users?select=*');
    return result || [];
  } catch (err) {
    console.error('getAllUsers error:', err);
    return [];
  }
}

export async function getUserRemindersToday(env, userPhone) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const result = await supabaseRequest(
      env,
      'GET',
      `/reminders?user_phone=eq.${encodeURIComponent(userPhone)}&due_at=gte.${today.toISOString()}&due_at=lt.${tomorrow.toISOString()}&status=eq.pending&order=due_at.asc`
    );
    return result || [];
  } catch (err) {
    console.error('getUserRemindersToday error:', err);
    return [];
  }
}

export async function getActiveNotesToday(env, userPhone) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const result = await supabaseRequest(
      env,
      'GET',
      `/notes?user_phone=eq.${encodeURIComponent(userPhone)}&status=eq.active&updated_at=gte.${today.toISOString()}&order=updated_at.desc&limit=10`
    );
    return result || [];
  } catch (err) {
    console.error('getActiveNotesToday error:', err);
    return [];
  }
}

export async function getTopEntities(env, userPhone) {
  try {
    const result = await supabaseRequest(
      env,
      'GET',
      `/entities?user_phone=eq.${encodeURIComponent(userPhone)}&open_items=gt.0&order=open_items.desc&limit=3`
    );
    return result || [];
  } catch (err) {
    console.error('getTopEntities error:', err);
    return [];
  }
}

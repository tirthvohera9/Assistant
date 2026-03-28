const VALID_INTENTS = new Set([
  'save_note',
  'set_reminder',
  'search_notes',
  'show_list',
  'mark_done',
  'snooze',
  'update_rule',
  'query_entity',
  'answer_question',
  'unclear'
]);

export function parseIntent(llmResponse) {
  if (!llmResponse || typeof llmResponse !== 'object') {
    return { intent: 'unclear', reply_message: "I couldn't understand that. Please try again." };
  }

  const intent = VALID_INTENTS.has(llmResponse.intent) ? llmResponse.intent : 'unclear';

  return {
    intent,
    note_content: llmResponse.note_content || null,
    reminder_time_iso: llmResponse.reminder_time_iso || null,
    reminder_message: llmResponse.reminder_message || null,
    search_query: llmResponse.search_query || null,
    entity_query: llmResponse.entity_query || null,
    list_filter: llmResponse.list_filter || 'all',
    snooze_duration: llmResponse.snooze_duration || '1h',
    rule_text: llmResponse.rule_text || null,
    people: Array.isArray(llmResponse.people) ? llmResponse.people.filter(Boolean) : [],
    projects: Array.isArray(llmResponse.projects) ? llmResponse.projects.filter(Boolean) : [],
    topics: Array.isArray(llmResponse.topics) ? llmResponse.topics.filter(Boolean) : [],
    tags: Array.isArray(llmResponse.tags) ? llmResponse.tags.filter(Boolean) : [],
    reply_message: llmResponse.reply_message || null
  };
}

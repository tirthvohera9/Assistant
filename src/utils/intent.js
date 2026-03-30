const VALID_INTENTS = new Set([
  'save_note',
  'save_checklist',
  'set_reminder',
  'search_notes',
  'show_list',
  'show_topics',
  'mark_done',
  'edit_note',
  'delete_note',
  'delete_reminder',
  'snooze',
  'update_rule',
  'query_entity',
  'answer_question',
  'pin_note',
  'export_notes',
  'set_timezone',
  'bulk_action',
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
    new_content: llmResponse.new_content || null,
    note_number: typeof llmResponse.note_number === 'number' ? Math.round(llmResponse.note_number) : null,
    reminder_time_iso: llmResponse.reminder_time_iso || null,
    reminder_message: llmResponse.reminder_message || null,
    recurrence: llmResponse.recurrence || 'none',
    search_query: llmResponse.search_query || null,
    entity_query: llmResponse.entity_query || null,
    list_filter: llmResponse.list_filter || 'all',
    topic_filter: llmResponse.topic_filter || null,
    snooze_duration: llmResponse.snooze_duration || '1h',
    snooze_search_query: llmResponse.snooze_search_query || null,
    edit_search_query: llmResponse.edit_search_query || null,
    delete_all: llmResponse.delete_all === true,
    rule_text: llmResponse.rule_text || null,
    people: Array.isArray(llmResponse.people) ? llmResponse.people.filter(Boolean) : [],
    projects: Array.isArray(llmResponse.projects) ? llmResponse.projects.filter(Boolean) : [],
    topics: Array.isArray(llmResponse.topics) ? llmResponse.topics.filter(Boolean) : [],
    tags: Array.isArray(llmResponse.tags) ? llmResponse.tags.filter(Boolean) : [],
    reply_message: llmResponse.reply_message || null,
    checklist_items: Array.isArray(llmResponse.checklist_items) ? llmResponse.checklist_items.filter(Boolean) : [],
    timezone_value: llmResponse.timezone_value || null,
    bulk_target: llmResponse.bulk_target || null,
    smart_reminder_time: llmResponse.smart_reminder_time || null,
    pin: llmResponse.pin === true
  };
}

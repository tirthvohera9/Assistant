import { getDueReminders, updateReminderStatus, getAllUsers, getUserRemindersToday, getActiveNotesToday, getTopEntities } from '../services/supabase.js';
import { sendTextMessage, sendInteractiveButtons } from '../services/whatsapp.js';
import { composeBriefing } from '../services/groq.js';

export async function checkReminders(request, env) {
  try {
    const dueReminders = await getDueReminders(env);

    for (const reminder of dueReminders) {
      try {
        await sendInteractiveButtons(env, reminder.user_phone, reminder.message, reminder.id);
        await updateReminderStatus(env, reminder.id, 'sent');
      } catch (err) {
        console.error(`Failed to send reminder ${reminder.id}:`, err);
      }
    }

    return new Response(JSON.stringify({ processed: dueReminders.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('checkReminders error:', err);
    return new Response('Error', { status: 500 });
  }
}

export async function sendBriefings(request, env) {
  try {
    const users = await getAllUsers(env);

    for (const user of users) {
      try {
        const todaysReminders = await getUserRemindersToday(env, user.phone);
        const activeNotes = await getActiveNotesToday(env, user.phone);
        const topEntities = await getTopEntities(env, user.phone);

        const briefingText = await composeBriefing(env, {
          reminders: todaysReminders,
          notes: activeNotes,
          entities: topEntities
        });

        await sendTextMessage(env, user.phone, briefingText);
      } catch (err) {
        console.error(`Failed to send briefing to ${user.phone}:`, err);
      }
    }

    return new Response(JSON.stringify({ sent: users.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('sendBriefings error:', err);
    return new Response('Error', { status: 500 });
  }
}

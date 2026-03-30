import { getDueReminders, updateReminderStatus, getAllUsers, getUserRemindersToday, getActiveNotesToday, getTopEntities, getSentUnacknowledgedReminders, markReminderSent, createNextRecurrence } from '../services/supabase.js';
import { sendTextMessage, sendInteractiveButtons } from '../services/telegram.js';
import { composeBriefing } from '../services/openrouter.js';

export async function checkReminders(request, env) {
  try {
    // Fire due reminders
    const dueReminders = await getDueReminders(env);
    for (const reminder of dueReminders) {
      try {
        await sendInteractiveButtons(env, reminder.user_phone, reminder.message, reminder.id);
        await markReminderSent(env, reminder.id);

        // Feature 1: create next occurrence for recurring reminders
        if (reminder.recurrence && reminder.recurrence !== 'none') {
          await createNextRecurrence(env, reminder);
        }
      } catch (err) {
        console.error(`Failed to send reminder ${reminder.id}:`, err);
      }
    }

    // Feature 10: re-send unacknowledged reminders (sent > 30 min ago)
    const unacknowledged = await getSentUnacknowledgedReminders(env);
    for (const reminder of unacknowledged) {
      try {
        await sendInteractiveButtons(env, reminder.user_phone, `🔔 Reminder (follow-up): ${reminder.message}`, reminder.id);
        // Mark done so it won't be re-sent again
        await updateReminderStatus(env, reminder.id, 'done');
      } catch (err) {
        console.error(`Failed to re-send reminder ${reminder.id}:`, err);
      }
    }

    return new Response(JSON.stringify({
      processed: dueReminders.length,
      renotified: unacknowledged.length
    }), {
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

    await Promise.all(users.map(async user => {
      try {
        const [todaysReminders, activeNotes, topEntities] = await Promise.all([
          getUserRemindersToday(env, user.phone),
          getActiveNotesToday(env, user.phone),
          getTopEntities(env, user.phone)
        ]);

        const briefingText = await composeBriefing(env, {
          reminders: todaysReminders,
          notes: activeNotes,
          entities: topEntities
        });

        await sendTextMessage(env, user.phone, briefingText);
      } catch (err) {
        console.error(`Failed to send briefing to ${user.phone}:`, err);
      }
    }));

    return new Response(JSON.stringify({ sent: users.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('sendBriefings error:', err);
    return new Response('Error', { status: 500 });
  }
}

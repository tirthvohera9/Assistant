import { verifyWebhook, receiveWebhook } from './handlers/webhook.js';
import { checkReminders, sendBriefings } from './handlers/cron.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === '/webhook' && method === 'GET') {
        return verifyWebhook(request, env);
      }

      if (path === '/webhook' && method === 'POST') {
        return receiveWebhook(request, env);
      }

      if (path === '/cron/reminders' && method === 'POST') {
        return checkReminders(request, env);
      }

      if (path === '/cron/briefing' && method === 'POST') {
        return sendBriefings(request, env);
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      console.error('Unhandled error in fetch:', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  }
};

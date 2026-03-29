import { receiveWebhook } from './handlers/webhook.js';
import { checkReminders, sendBriefings } from './handlers/cron.js';
import { setWebhook } from './services/telegram.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // Telegram sends all updates as POST to /webhook
      if (path === '/webhook' && method === 'POST') {
        return receiveWebhook(request, env, ctx);
      }

      // One-time setup: call this URL in browser to register webhook with Telegram
      if (path === '/setup' && method === 'GET') {
        const workerUrl = `${url.protocol}//${url.host}`;
        const result = await setWebhook(env, workerUrl);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (path === '/cron/reminders' && method === 'POST') {
        return checkReminders(request, env);
      }

      if (path === '/cron/briefing' && method === 'POST') {
        return sendBriefings(request, env);
      }

      if (path === '/' || path === '/webhook') {
        return new Response('Chief is running.', { status: 200 });
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      console.error('Unhandled error in fetch:', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  }
};

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

      // Diagnostic: test OpenRouter connection
      if (path === '/test-openrouter' && method === 'GET') {
        try {
          const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://chief-assistant.workers.dev',
              'X-Title': 'Chief'
            },
            body: JSON.stringify({
              model: env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free',
              messages: [{ role: 'user', content: 'Say "OK" in one word.' }],
              max_tokens: 10
            })
          });
          const text = await response.text();
          return new Response(JSON.stringify({
            status: response.status,
            ok: response.ok,
            key_present: !!env.OPENROUTER_API_KEY,
            key_prefix: env.OPENROUTER_API_KEY ? env.OPENROUTER_API_KEY.substring(0, 8) + '...' : 'MISSING',
            model: env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free',
            response: text
          }, null, 2), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
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

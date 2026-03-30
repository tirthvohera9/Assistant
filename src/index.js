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

      // Diagnostic: list available free models on this account
      if (path === '/test-openrouter' && method === 'GET') {
        try {
          const modelsRes = await fetch('https://openrouter.ai/api/v1/models', {
            headers: { 'Authorization': `Bearer ${env.OPENROUTER_API_KEY}` }
          });
          const modelsData = await modelsRes.json();
          const freeModels = (modelsData.data || [])
            .filter(m => m.id && (m.id.endsWith(':free') || (m.pricing && m.pricing.prompt === '0')))
            .map(m => m.id)
            .sort();

          // Test the current model with a real call
          const model = env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';
          const testRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://chief-assistant.workers.dev',
              'X-Title': 'Chief'
            },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: 'Reply with just the word OK.' }],
              max_tokens: 10
            })
          });
          const testData = await testRes.json();
          const testReply = testData.choices?.[0]?.message?.content || null;
          const testError = testData.error || null;

          return new Response(JSON.stringify({
            key_present: !!env.OPENROUTER_API_KEY,
            current_model: model,
            model_test: { status: testRes.status, reply: testReply, error: testError },
            free_models_available: freeModels
          }, null, 2), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), {
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

const TELEGRAM_API = `https://api.telegram.org/bot`;

function api(token, method) {
  return `${TELEGRAM_API}${token}/${method}`;
}

export async function sendTextMessage(env, chatId, text) {
  const response = await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown'
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Telegram sendMessage failed: ${err}`);
  }

  return response.json();
}

export async function sendInteractiveButtons(env, chatId, message, reminderId) {
  const response = await fetch(api(env.TELEGRAM_BOT_TOKEN, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      reply_markup: {
        inline_keyboard: [[
          { text: 'Done', callback_data: `done_${reminderId}` },
          { text: 'Snooze 1 Hour', callback_data: `snooze1h_${reminderId}` },
          { text: 'Tomorrow', callback_data: `snoozetomorrow_${reminderId}` }
        ]]
      }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Telegram sendMessage (buttons) failed: ${err}`);
  }

  return response.json();
}

export async function answerCallbackQuery(env, callbackQueryId) {
  await fetch(api(env.TELEGRAM_BOT_TOKEN, 'answerCallbackQuery'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId })
  });
}

export async function downloadTelegramFile(env, fileId) {
  // Step 1: Get file path
  const fileResponse = await fetch(api(env.TELEGRAM_BOT_TOKEN, `getFile?file_id=${fileId}`));

  if (!fileResponse.ok) {
    throw new Error('Failed to get Telegram file info');
  }

  const fileData = await fileResponse.json();
  const filePath = fileData.result?.file_path;

  if (!filePath) {
    throw new Error('No file path returned from Telegram');
  }

  // Step 2: Download file
  const downloadUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
  const mediaResponse = await fetch(downloadUrl);

  if (!mediaResponse.ok) {
    throw new Error('Failed to download Telegram file');
  }

  return mediaResponse.arrayBuffer();
}

export async function setWebhook(env, workerUrl) {
  const webhookUrl = `${workerUrl}/webhook`;
  const response = await fetch(api(env.TELEGRAM_BOT_TOKEN, 'setWebhook'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl })
  });

  return response.json();
}

const WHATSAPP_API_BASE = 'https://graph.facebook.com/v19.0';

export async function sendTextMessage(env, phone, message) {
  const url = `${WHATSAPP_API_BASE}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'text',
    text: { body: message }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`WhatsApp send failed: ${err}`);
  }

  return response.json();
}

export async function sendInteractiveButtons(env, phone, message, reminderId) {
  const url = `${WHATSAPP_API_BASE}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: message },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: { id: `done_${reminderId}`, title: 'Done' }
          },
          {
            type: 'reply',
            reply: { id: `snooze1h_${reminderId}`, title: 'Snooze 1 Hour' }
          },
          {
            type: 'reply',
            reply: { id: `snoozetomorrow_${reminderId}`, title: 'Tomorrow' }
          }
        ]
      }
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`WhatsApp interactive send failed: ${err}`);
  }

  return response.json();
}

export async function downloadWhatsAppMedia(env, mediaId) {
  // Step 1: Get media URL
  const metaUrl = `${WHATSAPP_API_BASE}/${mediaId}`;
  const metaResponse = await fetch(metaUrl, {
    headers: {
      'Authorization': `Bearer ${env.WHATSAPP_TOKEN}`
    }
  });

  if (!metaResponse.ok) {
    const err = await metaResponse.text();
    throw new Error(`WhatsApp media metadata failed: ${err}`);
  }

  const metaData = await metaResponse.json();
  const mediaUrl = metaData.url;

  if (!mediaUrl) {
    throw new Error('No media URL returned from WhatsApp');
  }

  // Step 2: Download media binary
  const mediaResponse = await fetch(mediaUrl, {
    headers: {
      'Authorization': `Bearer ${env.WHATSAPP_TOKEN}`
    }
  });

  if (!mediaResponse.ok) {
    const err = await mediaResponse.text();
    throw new Error(`WhatsApp media download failed: ${err}`);
  }

  return mediaResponse.arrayBuffer();
}

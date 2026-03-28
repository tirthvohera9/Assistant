const HF_API_URL = 'https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2';

export async function generateEmbedding(env, text) {
  try {
    const response = await fetch(HF_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.HUGGINGFACE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ inputs: text })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`HuggingFace API error: ${err}`);
    }

    const result = await response.json();

    // Result may be a nested array or flat array depending on API version
    if (Array.isArray(result)) {
      // If nested (batch result), take first element
      if (Array.isArray(result[0])) {
        return result[0];
      }
      return result;
    }

    throw new Error('Unexpected embedding format');
  } catch (err) {
    console.error('generateEmbedding error:', err);
    // Return null embedding on failure - note will be saved without vector search support
    return null;
  }
}

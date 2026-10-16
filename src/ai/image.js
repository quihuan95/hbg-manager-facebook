import { config } from '../config.js';

export async function generateImage(topic, profileName, ruleText, customBrief = '') {
  if (!config.openai.apiKey) {
    throw new Error('Chưa cấu hình OPENAI_API_KEY trên server.');
  }

  const model = config.openai.imageModel || 'gpt-image-1';
  const prompt = customBrief
    ? `Commercial high quality advertising visual for ${profileName}. Concept: ${customBrief}. Style: elegant corporate photography, clean minimalist composition, sharp 8k details, no messy text or logos in AI layer.`
    : `A sleek, high-end professional corporate photography for "${profileName}", representing the theme: "${topic}". Clean lighting, premium aesthetic, corporate elegance, 8k resolution style, no chaotic text overlay.`;

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openai.apiKey}`
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      size: '1024x1024'
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Lỗi DALL-E API: ${res.statusText}`);
  }

  const data = await res.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('Không nhận được dữ liệu ảnh từ DALL-E.');

  return {
    imageData: `data:image/png;base64,${b64}`,
    imageMime: 'image/png',
    model,
    prompt
  };
}

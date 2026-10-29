import { config } from '../config.js';

export async function generateImage(topic, profileName, ruleText, customBrief = '') {
  if (!config.openai.apiKey) {
    throw new Error('Chưa cấu hình OPENAI_API_KEY trên server.');
  }

  const model = config.openai.imageModel || 'gpt-image-1';
  const profileRule = String(ruleText || '').trim();
  const prompt = [
    `Create a commercial-quality advertising visual for "${profileName}" about: "${topic}".`,
    'Style priority, from highest to lowest: manual prompt, Sheet image rule, default Profile rule. When style directions conflict, follow the higher-priority direction. Brand safety, factual accuracy, and prohibitions always remain mandatory.',
    customBrief && `Higher-priority article image direction:\n${customBrief}`,
    profileRule && `Lowest-priority default Profile rules:\n${profileRule}`,
    'Use a clean, professional composition. Do not invent logos, claims, prices, people, venues, or factual evidence. Avoid messy text in the generated image.'
  ].filter(Boolean).join('\n\n');

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

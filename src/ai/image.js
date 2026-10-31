import { config } from '../config.js';

export async function planImageBriefs({ topic, caption, profileName, ruleText, customBrief = '', maxImages = 6 }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.openai.apiKey}` },
    body: JSON.stringify({
      model: config.openai.textModel || 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      temperature: 0.2,
      messages: [
        { role: 'system', content: `Analyze a social post and decide which distinct ideas genuinely need visual explanation. Return JSON {"briefs":["..."]}. Use 1 to ${maxImages} concise, standalone commercial image briefs. Do not create redundant decorative images or invent facts. Apply this optional visual direction to every relevant brief: ${customBrief || 'none'}. Follow these brand rules:\n${ruleText}` },
        { role: 'user', content: `Brand: ${profileName}\nTopic: ${topic}\nPost:\n${caption}` }
      ]
    })
  });
  if (!res.ok) throw new Error(`Không thể phân tích số lượng ảnh cần tạo: ${res.statusText}`);
  const data = await res.json();
  let parsed = {};
  try { parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}'); } catch {}
  const briefs = Array.isArray(parsed.briefs) ? parsed.briefs.map(String).map(value => value.trim()).filter(Boolean).slice(0, maxImages) : [];
  return briefs.length ? briefs : [`Minh họa chuyên nghiệp cho chủ đề: ${topic}`];
}

export async function generateImage(topic, profileName, ruleText, customBrief = '', referenceImages = []) {
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

  const hasReferences = Array.isArray(referenceImages) && referenceImages.length > 0;
  let body;
  let headers = { 'Authorization': `Bearer ${config.openai.apiKey}` };
  if (hasReferences) {
    body = new FormData();
    body.append('model', model);
    body.append('prompt', `${prompt}\n\nUse the supplied source images as visual references. Preserve recognizable people, places, products and brand details; do not fabricate factual evidence.`);
    body.append('size', '1024x1024');
    referenceImages.forEach((image, index) => {
      body.append('image[]', new Blob([image.buffer], { type: image.mimeType }), image.name || `source-${index + 1}.png`);
    });
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ model, prompt, n: 1, size: '1024x1024' });
  }
  const res = await fetch(hasReferences ? 'https://api.openai.com/v1/images/edits' : 'https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers,
    body
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

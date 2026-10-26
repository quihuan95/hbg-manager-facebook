import { config } from '../config.js';

export async function generateCaption(topic, profileName, ruleText, promptContext = '') {
  if (!config.openai.apiKey) {
    throw new Error('Chưa cấu hình OPENAI_API_KEY trên server.');
  }

  const systemPrompt = `Bạn là chuyên gia biên tập nội dung marketing cao cấp của The HBG Content Studio.
Nhiệm vụ: Viết bài đăng Facebook hoàn chỉnh cho thương hiệu "${profileName}".

QUY TẮC THƯƠNG HIỆU BẮT BUỘC:
${ruleText}

YÊU CẦU ĐỊNH DẠNG:
- Trả về duy nhất một đối tượng JSON hợp lệ theo schema sau:
{
  "headline": "Tiêu đề ngắn gọn, thu hút (chữ in hoa hoặc nổi bật)",
  "caption": "Nội dung bài viết hoàn chỉnh, chia đoạn mạch lạc, dễ đọc trên di động",
  "cta": "Câu kêu gọi hành động phù hợp",
  "image_brief": "Mô tả ngắn gọn ý tưởng bố cục cho hình ảnh",
  "used_facts": []
}
- Tuyệt đối tuân thủ các từ ngữ và giới hạn được nêu trong quy tắc thương hiệu (QUY TẮC THƯƠNG HIỆU BẮT BUỘC).
- Tuyệt đối KHÔNG tự bịa số liệu, giá tour, chứng nhận hoặc khách hàng không có trong rule.
- Giữ văn phong chuyên nghiệp, đúng định vị thương hiệu.`;

  const userPrompt = `Chủ đề bài viết: "${topic}".
${promptContext ? `Thông tin bổ sung: ${promptContext}` : ''}
Hãy tạo nội dung JSON chuẩn theo quy tắc.`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openai.apiKey}`
    },
    body: JSON.stringify({
      model: config.openai.textModel || 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 1200
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Lỗi OpenAI API: ${res.statusText}`);
  }

  const data = await res.json();
  const rawContent = data.choices?.[0]?.message?.content;
  if (!rawContent) throw new Error('OpenAI không trả về nội dung.');

  try {
    const parsed = JSON.parse(rawContent);
    return {
      headline: parsed.headline || topic.toUpperCase(),
      caption: parsed.caption || '',
      cta: parsed.cta || '',
      imageBrief: parsed.image_brief || '',
      model: config.openai.textModel
    };
  } catch {
    return {
      headline: topic.toUpperCase(),
      caption: rawContent,
      cta: '',
      imageBrief: '',
      model: config.openai.textModel
    };
  }
}

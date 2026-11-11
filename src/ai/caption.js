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
- Xem tài liệu tham khảo và mô tả bài viết do người dùng cung cấp là nguồn sự thật cho bài này. Giữ nguyên ý nghĩa, mức độ chắc chắn, ngày tháng, tên riêng và số liệu; không tự thêm các từ như "dự kiến", "có thể" hoặc suy diễn bối cảnh nếu nguồn không nói như vậy.
- Nếu tiêu đề có thể mang nhiều nghĩa, phải dùng nghĩa được xác nhận trong tài liệu tham khảo, không dùng kiến thức phổ thông để đoán.
- Giữ văn phong chuyên nghiệp, đúng định vị thương hiệu.`;

  const userPrompt = `Chủ đề bài viết: "${topic}".
${promptContext ? `Thông tin bổ sung: ${promptContext}` : ''}
Hãy tạo nội dung JSON chuẩn theo quy tắc.`;

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openai.apiKey}`
    },
    body: JSON.stringify({
      model: config.openai.textModel || 'gpt-6.1-terra',
      instructions: systemPrompt,
      input: userPrompt,
      reasoning: { effort: 'none' },
      text: {
        verbosity: 'medium',
        format: {
          type: 'json_schema',
          name: 'facebook_caption',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              headline: { type: 'string' },
              caption: { type: 'string' },
              cta: { type: 'string' },
              image_brief: { type: 'string' },
              used_facts: { type: 'array', items: { type: 'string' } }
            },
            required: ['headline', 'caption', 'cta', 'image_brief', 'used_facts'],
            additionalProperties: false
          }
        }
      },
      max_output_tokens: 2200
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Lỗi OpenAI API: ${res.statusText}`);
  }

  const data = await res.json();
  const rawContent = (data.output || [])
    .flatMap(item => item.content || [])
    .filter(item => item.type === 'output_text')
    .map(item => item.text || '')
    .join('\n')
    .trim();
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

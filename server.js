// ============================================================
// Fanpage Auto-Reply Bot — Webhook cho Messenger Platform (Meta)
// ------------------------------------------------------------
// Chạy:  npm install && npm start   (cần Node.js 18 trở lên)
// Env:  xem file .env.example
// ============================================================

import express from 'express';
import crypto from 'crypto';

const {
  PAGE_ACCESS_TOKEN,          // Token của fanpage (lấy từ Meta App Dashboard)
  APP_SECRET,                 // App Secret (Settings > Basic)
  VERIFY_TOKEN,               // Chuỗi tự đặt, dùng khi cấu hình webhook
  AI_API_KEY,                 // Key của AI (OpenAI hoặc dịch vụ tương thích)
  AI_BASE_URL = 'https://api.openai.com/v1',
  AI_MODEL = 'gpt-4o-mini',
  BUSINESS_NAME = 'Fanpage của bạn',
  BUSINESS_INFO = '',         // Mô tả ngắn: sản phẩm, giờ mở cửa, địa chỉ...
  PORT = 3000,
} = process.env;

if (!PAGE_ACCESS_TOKEN || !VERIFY_TOKEN || !AI_API_KEY) {
  console.warn('⚠️  Thiếu biến môi trường: PAGE_ACCESS_TOKEN, VERIFY_TOKEN hoặc AI_API_KEY');
}

const app = express();
// Giữ raw body để kiểm tra chữ ký webhook của Meta
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// 1) Meta gọi GET này để xác minh webhook khi bạn bấm "Verify and Save"
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook đã được Meta xác minh');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// 2) Kiểm tra chữ ký để chắc request đến từ Meta
function verifySignature(req) {
  if (!APP_SECRET) return true; // chưa cấu hình thì bỏ qua (không khuyến khích)
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// 3) Nhận tin nhắn mới từ fanpage
app.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401);
  res.sendStatus(200); // trả lời Meta ngay, xử lý tiếp ở dưới

  const body = req.body;
  if (body.object !== 'page') return;
  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      handleEvent(event).catch((e) => console.error('Lỗi xử lý tin nhắn:', e.message));
    }
  }
});

async function handleEvent(event) {
  const senderId = event.sender && event.sender.id;
  if (!senderId) return;
  if (event.message && event.message.is_echo) return; // bỏ qua tin do chính Page gửi

  const text = event.message && typeof event.message.text === 'string'
    ? event.message.text.trim()
    : '';

  if (!text) {
    await sendText(
      senderId,
      'Cảm ơn bạn đã nhắn tin! Hiện tại mình chỉ trả lời được tin nhắn văn bản, bạn vui lòng gõ câu hỏi giúp mình nhé.'
    );
    return;
  }

  await senderAction(senderId, 'typing_on'); // hiện "đang nhập..."
  const reply = await aiReply(text);
  await senderAction(senderId, 'typing_off');
  await sendText(senderId, reply);
}

// 4) Gọi AI để sinh câu trả lời thông minh
async function aiReply(userText) {
  const system =
    `Bạn là nhân viên chăm sóc khách hàng của "${BUSINESS_NAME}". ` +
    `Thông tin doanh nghiệp: ${BUSINESS_INFO || '(chưa cung cấp)'}. ` +
    `Trả lời bằng tiếng Việt, ngắn gọn (dưới 150 từ), thân thiện, đúng trọng tâm câu hỏi. ` +
    `Tuyệt đối không bịa đặt giá cả, chính sách, khuyến mãi. ` +
    `Nếu không chắc chắn, hãy nói sẽ chuyển cho nhân viên hỗ trợ và xin số điện thoại của khách.`;

  const r = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userText },
      ],
      max_tokens: 300,
      temperature: 0.7,
    }),
  });

  if (!r.ok) {
    console.error('AI API lỗi:', r.status, await r.text());
    throw new Error(`AI API trả về lỗi ${r.status}`);
  }
  const data = await r.json();
  const content = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content.trim()
    : '';
  return content || 'Cảm ơn bạn đã nhắn tin! Bên mình sẽ phản hồi sớm nhất có thể.';
}

// 5) Gửi tin nhắn trả lời qua Messenger Send API
async function sendText(psid, text) {
  const r = await fetch(
    `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: psid },
        messaging_type: 'RESPONSE',
        message: { text: text.slice(0, 2000) },
      }),
    }
  );
  if (!r.ok) console.error('Send API lỗi:', r.status, await r.text());
}

async function senderAction(psid, action) {
  try {
    await fetch(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: psid }, sender_action: action }),
      }
    );
  } catch { /* bỏ qua lỗi typing indicator */ }
}

app.get('/', (_req, res) => res.send('✅ Fanpage bot đang chạy.'));

app.listen(PORT, () => console.log(`🚀 Bot đang lắng nghe ở cổng ${PORT}`));

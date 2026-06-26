require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk').default;

const app = express();
const PORT = process.env.PORT || 3000;
const INQUIRY_POST_URL = ''; // 後で設定

app.use(express.json());
app.use(express.static('public'));

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// パーセントエンコードされたShift-JIS文字列をUTF-8に変換
function decodeShiftJIS(str) {
  if (!str || !/%[0-9A-Fa-f]{2}/.test(str)) return str || '';
  const bytes = [];
  const s = str.replace(/\+/g, ' ');
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%' && i + 2 < s.length) {
      bytes.push(parseInt(s.substr(i + 1, 2), 16));
      i += 2;
    } else {
      bytes.push(s.charCodeAt(i) & 0xff);
    }
  }
  try {
    return new TextDecoder('shift-jis').decode(Buffer.from(bytes));
  } catch (e) {
    return str;
  }
}

const buildSystemPrompt = ({ user_id, user_name, user_point, user_token } = {}) => `あなたは占いを用いたメールカウンセリングサービスのサポートチャットボットです。
以下のユーザー情報を把握した上で対応してください。

会員ID：${user_id || ''}
ユーザー名：${user_name || ''}
所持ポイント：${user_point || ''}
ユーザートークン：${user_token || ''}

ユーザーから挨拶があった場合は名前を呼んで応答してください。
ポイントについて聞かれた場合は所持ポイントを答えてください。

【回答できる場合】
ポイント単価・購入方法・機能説明・キャンペーン情報など、
一般的な知識や説明で解決できる問い合わせには日本語で丁寧に回答してください。

【回答できない場合】
以下に該当する場合はAIでは対応できません：
- 特定のアカウントに関する問題（残高の誤差、特定の取引履歴など）
- 個人情報の確認が必要な対応
- 先生からの返信に関する個別の対応
- 返金・課金の具体的な処理
- システム不具合・技術的障害
- その他、人間のオペレーターが必要と判断したケース

回答できない場合は、他の文章を一切付けずに以下のJSONのみで返答してください：
{"can_answer":false}`;

// チャットエンドポイント
app.post('/chat', async (req, res) => {
  const { genre, messages } = req.body;
  const user_id    = decodeShiftJIS(req.body.user_id);
  const user_name  = decodeShiftJIS(req.body.user_name);
  const user_point = decodeShiftJIS(req.body.user_point);
  const user_token = decodeShiftJIS(req.body.user_token);

  console.log('【受信ユーザー情報】', { user_id, user_name, user_point, user_token });

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messagesが必要です' });
  }

  const systemPrompt = buildSystemPrompt({ user_id, user_name, user_point, user_token })
    + `\n\n【現在の問い合わせジャンル】${genre || 'その他'}`;

  console.log('【システムプロンプト】\n' + systemPrompt);

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    const text = (response.content.find(b => b.type === 'text')?.text ?? '').trim();

    // JSON形式で {"can_answer":false} が返ってきた場合
    try {
      const parsed = JSON.parse(text);
      if (parsed.can_answer === false) {
        return res.json({ can_answer: false });
      }
    } catch (_) {}

    res.json({ can_answer: true, reply: text });
  } catch (err) {
    console.error('Claude APIエラー:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 問い合わせ送信エンドポイント
app.post('/inquiry', async (req, res) => {
  const { genre, content, timestamp } = req.body;

  const inquiryData = { genre, content, timestamp };
  console.log('【問い合わせ受信】', JSON.stringify(inquiryData, null, 2));

  if (INQUIRY_POST_URL) {
    try {
      const r = await fetch(INQUIRY_POST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(inquiryData),
      });
      console.log('POST送信完了 status:', r.status);
    } catch (err) {
      console.error('POST送信エラー:', err.message);
    }
  } else {
    console.log('（POST送信先URL未設定のためログのみ）');
  }

  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`サーバー起動: http://localhost:${PORT}`);
});

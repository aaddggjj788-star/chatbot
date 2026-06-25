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

const SYSTEM_PROMPT = `あなたはサポートセンターのAIアシスタントです。
ユーザーの問い合わせに対して、以下のルールに従って対応してください。

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

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messagesが必要です' });
  }

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      system: SYSTEM_PROMPT + `\n\n【現在の問い合わせジャンル】${genre || 'その他'}`,
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

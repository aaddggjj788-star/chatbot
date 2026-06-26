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

const buildSystemPrompt = ({ user_id, user_name, user_point, user_token } = {}) => `あなたは占いを用いたメールカウンセリングサービス「RUNE」のサポートチャットボットです。
以下のユーザー情報を把握した上で丁寧に対応してください。

会員ID：${user_id || ''}
ユーザー名：${user_name || ''}
所持ポイント：${user_point || ''}

【対応ジャンルと回答内容】

■ポイント単価について
・1ポイント＝10円
・メッセージ送信は1通につき150pt必要
・その他の費用はかからない

■ポイント購入方法
・銀行振込、クレジットカード決済、コンビニ決済「ネットライドキャッシュ」が利用可能
・以下のURLへ案内する
https://x7j4l2p9m1.com/log_index.php?page=pointtuika&s=1782435196&ddv=${user_token || ''}

■機能の説明
・届いたメッセージは必ずメッセージボックスに保存されている
・新着メッセージボックスは一度開封すると表示されなくなり、メッセージボックスのみに表示される
・通知メールが届かない場合はフィルタリング設定の見直しかマイページのメッセージボックスをこまめに確認するよう案内
・送信したメッセージは送信済みメールボックスで確認できる
・ラッキーくじは1日1回無料で抽選可能
・当選賞品は受け取りページへ進むことでアカウントに登録される
・賞品の種類：ポイント増加クーポン、ポイントプレゼント、メッセージ送信割引チケット
・割引チケットの利用を希望するお客様には特典申請フォームへキーワードを送るよう案内

■先生から返信が来ない
・返信期限は24時間以内が規定
・24時間以内であれば先生からの対応をお待ちいただく
・メッセージ機能に不具合はなく送信されたメッセージは先生に届いていることを説明
・特段先生が気づきやすい通知を送ることはできないことを説明
・私情（例：お金がないから連絡できないと伝えてほしい等）の伝言は、全会員様の平等性を図るため承れないことを説明

■ポイントの誤差
・送信履歴、ポイント追加履歴を確認の上、誤差があればサポートスタッフより修正が行われるので今しばらくお待ちいただくよう案内

■キャンペーンについて
・チャットボット内ではキャンペーンの確認ができないため
・「本日の開催企画の中でご不明な点をご記述ください」と促し
・お客様から送られてきた内容をまとめてサポートメールに送信する

【その他・自由入力の場合】
・上記ジャンルで対応できる内容であれば回答する
・対応できない内容の場合は問い合わせ内容を整理して以下のURLにPOSTで送信する
https://x7j4l2p9m1.com/log_index.php?page=kbt&kbt=275&s=${user_token || ''}

【重要なルール】
・ユーザー名は必ず「${user_name || ''}様」と呼ぶ
・丁寧で温かみのある対応を心がける
・ポイント残高を聞かれたら「現在${user_point || ''}ポイントをお持ちです」と答える
・URLを案内する際はそのままリンクとして表示する

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

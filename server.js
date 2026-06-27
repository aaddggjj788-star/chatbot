require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk').default;
const fs = require('fs');

// reply-checker.js との連携用（LINEから「送信」「スキップ」を受け取りポーリング通知）
const REPLY_STATE_FILE = '/tmp/rune-reply-state.json';

// mail-checker は依存パッケージが別環境にある場合があるため安全に読み込む
let startMailCheck = () => console.warn('mail-checker 未ロード');
let stopMailCheck  = () => console.warn('mail-checker 未ロード');
let isMailCheckRunning = () => false;
try {
  const mc = require('./mail-checker');
  startMailCheck    = mc.startMailCheck;
  stopMailCheck     = mc.stopMailCheck;
  isMailCheckRunning = mc.isMailCheckRunning;
} catch (e) {
  console.warn('mail-checker のロードに失敗しました:', e.message);
}

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

【ポイントについて】
・1ポイント＝10円
・メッセージ送信は1通につき150pt必要
・その他の費用はかからない
・ポイント残高を聞かれたら「現在${user_point || ''}ポイントをお持ちです」と答える

【ポイント購入方法】
・銀行振込、クレジットカード決済、コンビニ決済「ネットライドキャッシュ」が利用可能
・ポイント購入ページのURLは以下の通り（購入ページへのご案内に使用）：
  https://x7j4l2p9m1.com/log_index.php?page=pointtuika&s=${Math.floor(Date.now() / 1000)}&ddv=${user_token || ''}
・銀行振込の場合：銀行側にて入金が確認でき次第、完了通知が届く。サポートスタッフにてお客様のアカウントへ反映するので今しばらくお待ちいただくよう案内する
・クレジットカード決済の場合：決済完了の即時にポイントが付与される。付与されていない場合は決済が正常に完了していない可能性があるため、改めて決済状況を確認するよう案内する
・ネットライドキャッシュの場合：発行されたプリペイド番号を決済ページにて正しく入力することで決済が行われる。ポイントが追加されていない場合は正しくプリペイド番号が入力できていない可能性があるため確認を促す

【機能の説明】
・送信したメッセージは送信済みメールボックスで確認できる
・届いたメッセージは必ずメッセージボックスに保存されている
・新着メッセージボックスは一度開封すると表示されなくなり、メッセージボックスのみに表示される
・ラッキーくじは1日1回無料で抽選可能。当選賞品は受け取りページへ進むことでアカウントに登録される
・賞品の種類：ポイント増加クーポン、ポイントプレゼント、メッセージ送信割引チケット
・割引チケットは特典申請フォームへキーワードを送ることで適用が開始される

【メッセージ機能・先生への問い合わせ】
・「先生から返信が来ない」という問い合わせには以下の文章をそのまま回答する：

現在、サイトシステム上ではメッセージ機能に不具合はなく、お送りいただいたメッセージは先生にしっかりと届いておりますのでご安心ください。

先生からのご返信につきましては、「24時間以内」を返信期限の規定とさせていただいております。

当番組では、鑑定のスケジュール、進行方法におきましては鑑定士の先生方にお任せしておりますので、お送りいただいてから24時間以内でございましたら、今しばらく先生からのご対応をお待ちいただけますと幸いです。

なお、会員様からの新着メッセージを開封されていない鑑定士の先生へは新着メッセージが届いている旨の通知を番組よりお送りしておりますが、こちらは会員様へお送りされる通知と同様の物となり、特段鑑定士の先生へ気付いて頂きやすい通知をお送りする事は出来ない仕様となっておりますので、何卒ご理解いただけますようお願い申し上げます。

その他ご不明な点がございましたら、お気軽にお問い合わせくださいませ。

・番組側から先生への伝言は全会員様の平等性を図るため承れない

【重要なルール】
・ユーザー名は必ず「${user_name || ''}様」と呼ぶ
・丁寧で温かみのある対応を心がける
・回答はシンプルかつ明確にまとめる
・以下に該当する場合は他の文章を一切付けずに{"can_answer":false}のみで返答する：
  - キャンペーン内容の確認（開催中のキャンペーン詳細や特典内容の問い合わせ）
  - 特定のアカウントへの直接操作・修正が必要な案件
  - 返金・課金の具体的な処理
  - その他、人間のオペレーターが対応すべきと判断した案件`;

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

    const text = (response.content.find(b => b.type === 'text')?.text ?? '').trim()
      .replace(/\*\*(.+?)\*\*/g, '「$1」');

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

// 問い合わせ文章自動生成エンドポイント
app.post('/generate-inquiry', async (req, res) => {
  const { messages, genre } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messagesが必要です' });
  }

  const historyText = messages
    .map(m => `${m.role === 'user' ? 'お客様' : 'ボット'}：${m.content}`)
    .join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 512,
      system: `あなたはサポートセンターへの問い合わせ文章を作成するアシスタントです。
提供された会話履歴をもとに、ユーザー本人がサポートセンターへ問い合わせする文章として生成してください。

出力形式は必ず以下の通りにしてください：
【お問い合わせ内容】
（ユーザー目線の問い合わせ文章）

ルール：
・一人称は「私」を使う
・「〜についてお伺いしたいです」「〜を教えていただけますか」などユーザー本人が問い合わせしている文体にする
・敬語は使うが、スタッフ口調（「〜とのことです」「〜とお伝えいただいております」「〜のお申し出がございました」など）は絶対に使わない
・ユーザーの意図を正しく汲み取り、拙い表現や箇条書きの入力でも自然な問い合わせ文章に整形する
・「【お問い合わせ内容】」という見出しから始め、1〜3文程度でまとめる
・前置きや余計な説明は一切付けず、上記形式のみを出力する

良い例：「本日開催中のキャンペーンで30,000円分のポイントを購入した場合、合計で何ポイントになるか教えていただけますか。」
悪い例：「会員様より、キャンペーンのポイント合計についてご確認のお申し出がございました。」`,
      messages: [{
        role: 'user',
        content: `以下の会話履歴（ジャンル：${genre || 'その他'}）をもとに、サポートスタッフ向けの問い合わせ文章を生成してください。\n\n${historyText}`,
      }],
    });

    const text = (response.content.find(b => b.type === 'text')?.text ?? '').trim();
    res.json({ message: text });
  } catch (err) {
    console.error('問い合わせ文章生成エラー:', err.message);
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

// ─── LINE Bot Webhook ─────────────────────────────────────────────

async function lineReply(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
  }).catch(err => console.error('LINE返信エラー:', err.message));
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  console.log('[LINE] 受信:', JSON.stringify(text));

  // reply-checker.js が返信待ち中なら「送信」「スキップ」をstate fileに書き込んで終了
  if ((text === '送信' || text === 'スキップ') && fs.existsSync(REPLY_STATE_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(REPLY_STATE_FILE, 'utf8'));
      if (state.status === 'waiting') {
        fs.writeFileSync(REPLY_STATE_FILE, JSON.stringify({ status: 'replied', reply: text }));
        return;
      }
    } catch (_) {}
  }

  if (text === '入金処理開始') {
    startMailCheck();
    return lineReply(replyToken, '入金処理を開始しました');
  }
  if (text === '入金処理停止') {
    stopMailCheck();
    return lineReply(replyToken, '入金処理を停止しました');
  }
  if (text === 'ステータス') {
    return lineReply(replyToken, isMailCheckRunning() ? '稼働中' : '停止中');
  }

  // 未対応メッセージはエコー返信
  return lineReply(replyToken, '受け取りました：' + text);
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // LINEは即時200が必要
  const events = req.body.events || [];
  await Promise.all(events.map(handleEvent));
});

// 未捕捉の例外・Promise拒否でプロセスが落ちないようにする
process.on('uncaughtException', (err) => {
  console.error('[FATAL] 未捕捉の例外:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] 未処理のPromise拒否:', reason);
});

const server = app.listen(PORT, () => {
  console.log(`サーバー起動: http://localhost:${PORT}`);
});
server.on('error', (err) => {
  console.error('[SERVER] listenエラー:', err.message);
});

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk').default;
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const REPLY_AUTO_CONFIG_FILE = path.join(
  __dirname,
  'reply-auto-config.json'
);

// reply-checker.js との連携用（LINEから「送信」「スキップ」を受け取りポーリング通知）
const REPLY_STATE_FILE = '/tmp/rune-reply-state.json';
// reply-checker.js が返信対象外（SKIP）ユーザーを書き出すファイル
const SKIPPED_FILE = '/tmp/rune-skipped.json';

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

// reply-checker は依存パッケージが別環境にある場合があるため安全に読み込む
let checkReplies = () => console.warn('reply-checker 未ロード');
let stopReplies  = () => console.warn('reply-checker 未ロード');
let sendManualReply = async () => console.warn('reply-checker 未ロード（sendManualReply）');
let inquireUserBody = async () => console.warn('reply-checker 未ロード（inquireUserBody）');
let batchSearchAndReply = async () => console.warn('reply-checker 未ロード（batchSearchAndReply）');
// sendManualReply へ渡す通知・返信待ち関数（reply-checker側の実装を共有する）
let rcSendLine = async () => console.warn('reply-checker 未ロード（sendLine）');
let rcWaitForLineReply = async () => { throw new Error('reply-checker 未ロード（waitForLineReply）'); };
try {
  const rc = require('./reply-checker');
  checkReplies = rc.checkReplies;
  stopReplies  = rc.stopReplies;
  sendManualReply = rc.sendManualReply;
  inquireUserBody = rc.inquireUserBody;
  batchSearchAndReply = rc.batchSearchAndReply;
  rcSendLine = rc.sendLine;
  rcWaitForLineReply = rc.waitForLineReply;
} catch (e) {
  console.warn('reply-checker のロードに失敗しました:', e.message);
}

// 「返信チェック開始」の多重起動防止
let isReplyCheckerRunning = false;
// ======================================================
// 自動返信巡回 設定管理
// ======================================================

function loadReplyAutoConfig() {
  const defaultConfig = {
    enabled: false,
    intervalMinutes: 20,
    targetKids: [],
    maxSendPerRun: 50,
    retry: {
      login: 2,
      pageLoad: 2,
      iframe: 2,
      send: 2
    }
  };

  try {
    if (!fs.existsSync(REPLY_AUTO_CONFIG_FILE)) {
      return defaultConfig;
    }

    const raw = fs.readFileSync(
      REPLY_AUTO_CONFIG_FILE,
      'utf8'
    );

    const saved = JSON.parse(raw);

    return {
      ...defaultConfig,
      ...saved,
      retry: {
        ...defaultConfig.retry,
        ...(saved.retry || {})
      }
    };

  } catch (err) {
    console.error(
      '[AUTO-REPLY] 設定ファイル読込エラー:',
      err.message
    );

    return defaultConfig;
  }
}

function saveReplyAutoConfig(config) {
  fs.writeFileSync(
    REPLY_AUTO_CONFIG_FILE,
    JSON.stringify(config, null, 2),
    'utf8'
  );
}

function updateReplyAutoConfig(changes) {
  const current = loadReplyAutoConfig();

  const updated = {
    ...current,
    ...changes
  };

  saveReplyAutoConfig(updated);

  return updated;
}

// support-checker は依存パッケージが別環境にある場合があるため安全に読み込む
let checkSupport = () => console.warn('support-checker 未ロード');
let stopSupport  = () => console.warn('support-checker 未ロード');
try {
  const sc = require('./support-checker');
  checkSupport = sc.checkSupport;
  stopSupport  = sc.stopSupport;
} catch (e) {
  console.warn('support-checker のロードに失敗しました:', e.message);
}

// contact-checker は依存パッケージが別環境にある場合があるため安全に読み込む
let checkContacts = () => console.warn('contact-checker 未ロード');
let stopContacts  = () => console.warn('contact-checker 未ロード');
try {
  const cc = require('./contact-checker');
  checkContacts = cc.checkContacts;
  stopContacts  = cc.stopContacts;
} catch (e) {
  console.warn('contact-checker のロードに失敗しました:', e.message);
}

// 「コンタクトチェック開始」の多重起動防止
let isContactCheckerRunning = false;

const app = express();
const PORT = process.env.PORT || 3000;
const INQUIRY_POST_URL = ''; // 後で設定

// Slackの署名検証には生のリクエストボディが必要なため、verifyで保持しておく
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
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

// Slackへ通知する。SLACK_WEBHOOK_URL が未設定なら何もしない
async function sendSlack(text) {
  if (!process.env.SLACK_WEBHOOK_URL) return;
  await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(err => console.error('Slack通知エラー:', err.message));
}

// SLACK_ONLY=true のときはLINE送信をスキップしてSlackのみに通知する。
// ただしSLACK_WEBHOOK_URL未設定時は無効とする（Slackにも送れずLINEも止まると
// 通知が完全に消えてしまうため）。各チェッカーの isSlackOnly() と同じ判定。
const SLACK_ONLY = process.env.SLACK_ONLY === 'true' && Boolean(process.env.SLACK_WEBHOOK_URL);

async function lineReply(replyToken, text) {
  // Slackにも通知する（SLACK_WEBHOOK_URL設定時のみ動作）
  await sendSlack(text);

  // SLACK_ONLY のときはLINE返信を行わない
  if (SLACK_ONLY) return;

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

// LINEへブロードキャスト送信する（replyTokenが使えない非同期処理の完了通知用）
// SLACK_WEBHOOK_URL設定時はSlackにも通知し、SLACK_ONLY=true時はSlackのみに通知する
async function lineBroadcast(text) {
  // Slackにも通知する（SLACK_WEBHOOK_URL設定時のみ動作）
  await sendSlack(text);

  // SLACK_ONLY のときはLINEブロードキャストを行わない
  if (SLACK_ONLY) return;

  await fetch('https://api.line.me/v2/bot/message/broadcast', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{ type: 'text', text }],
    }),
  }).catch(err => console.error('LINE通知エラー:', err.message));
}

// ─── 「返信対象外チェック」コマンド ───────────────────────────────
// reply-checker.js が /tmp/rune-skipped.json に書き出した
// 返信対象外（SKIP）ユーザーの一覧を読み込んで通知文を組み立てる
function buildSkippedUsersMessage() {
  let data;
  try {
    if (!fs.existsSync(SKIPPED_FILE)) {
      return '【返信対象外一覧】\n対象外ユーザーはいませんでした';
    }
    data = JSON.parse(fs.readFileSync(SKIPPED_FILE, 'utf8'));
  } catch (e) {
    console.error('[SKIPPED] 読み込みエラー:', e.message);
    return `【返信対象外一覧】\n読み込みに失敗しました：${e.message}`;
  }

  const skipped = Array.isArray(data?.skipped) ? data.skipped : [];
  if (skipped.length === 0) {
    return '【返信対象外一覧】\n対象外ユーザーはいませんでした';
  }

  const lines = skipped.map(u => `・${u.userName}（u_id: ${u.uid || '不明'}）\n  理由：${u.reason}`);

  // LINEの1メッセージ上限（5000文字）を超えると送信できないため、
  // 超える場合は件数を打ち切って残件数を末尾に付ける
  const MAX_LEN = 4800;
  const shown = [];
  let len = '【返信対象外一覧】'.length;
  for (const line of lines) {
    if (len + line.length + 1 > MAX_LEN) break;
    shown.push(line);
    len += line.length + 1;
  }
  const rest = lines.length - shown.length;

  return [
    '【返信対象外一覧】',
    ...shown,
    ...(rest > 0 ? [`（ほか${rest}件は文字数上限のため省略）`] : []),
  ].join('\n');
}

// ─── 「会員:{uid} {操作コマンド}」直接操作 ─────────────────────────
// 例:「会員:1042287 750pt追加」（「ポイント750pt追加」も可）
//    「会員:1042287 750pt減算」
//    「会員:1042287 レベル変更:10」
//    「会員:1042287 750pt追加 レベル変更:10」
// 各チェック処理（contact-checker等）を経由せず、会員IDを直接指定して
// 会員詳細ページを開き、同じ書式の操作コマンドを実行する

// contact-checker.js / support-checker.js の parseCommand と同じ書式で
// 操作コマンドを解析する（照会系ではなく更新系のコマンドのみを対象とする）
// ポイント操作は「ポイント」の接頭辞を省略でき、追加/減算のどちらも指定できる
// （point: { amount, sign } / signは追加なら '+'、減算なら '-'）
function parseMemberCommand(command) {
  const body = command || '';
  return {
    point: (m => (m ? { amount: m[1], sign: m[2] === '減算' ? '-' : '+' } : null))(body.match(/(?:ポイント)?(\d+)pt(追加|減算)/)),
    level: body.match(/レベル変更:(\d+)/)?.[1] ?? null,
    love:  (m => (m ? { charaId: m[1], value: m[2] } : null))(body.match(/絆変更:(\d+):(\d+)/)),
  };
}

// 管理画面へログインする（contact-checker.js の login と同じ手順）
async function loginToSystem(page) {
  const loginUrl = process.env.SYSTEM_URL || 'http://manager.x7j4l2p9m1.com/mg/mg_ope.php';
  await page.goto(loginUrl, { waitUntil: 'networkidle' });

  // セッション切れ対応
  const sessionLink = page.locator('a[href*="s_system"]');
  if (await sessionLink.count() > 0) {
    await sessionLink.first().click();
    await page.waitForLoadState('networkidle');
  }

  await page.fill('[name="id"]',   process.env.SYSTEM_LOGIN_ID);
  await page.fill('[name="pass"]', process.env.SYSTEM_LOGIN_PASS);
  await page.click('[name="login"]');
  await page.waitForLoadState('networkidle');
  console.log('[MEMBER-CMD] ログイン完了:', await page.title());
}

// 「会員:{uid} {操作コマンド}」を実行し、結果をLINEへ通知する
async function runMemberCommand(uid, command) {
  const DRY_RUN = process.env.DRY_RUN === 'true';
  const cmd = parseMemberCommand(command);
  console.log(`[MEMBER-CMD] uid=${uid} command="${command}" 解析結果=${JSON.stringify(cmd)}`);

  if (!cmd.point && !cmd.level && !cmd.love) {
    return lineBroadcast(
      `【エラー】会員ID：${uid}\n実行できる操作コマンドがありません：${command}\n` +
      '「{数値}pt追加」「{数値}pt減算」「レベル変更:{数値}」「絆変更:{キャラID}:{value}」が指定できます'
    );
  }

  const { chromium } = require('playwright');
  const { openKyouseitaikaiBySearch, adjustPoint, setPointLevel, setLoveLevel } = require('./utils');

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    httpCredentials: {
      username: process.env.BASIC_AUTH_ID,
      password: process.env.BASIC_AUTH_PASS,
    },
  });

  const results = [];
  try {
    const page = await context.newPage();
    await loginToSystem(page);

    // 会員検索から会員詳細ページを開く
    let kyouseiPage = await openKyouseitaikaiBySearch(page, uid);
    // フォーム送信後はページが遷移するため、次の操作前に開き直す
    let submitted = false;
    const freshKyouseiPage = async () => {
      if (submitted) {
        await kyouseiPage.close().catch(() => {});
        kyouseiPage = await openKyouseitaikaiBySearch(page, uid);
        submitted = false;
      }
      return kyouseiPage;
    };

    if (cmd.point) {
      const { amount, sign } = cmd.point;
      if (DRY_RUN) {
        results.push(`ポイント：${sign}${amount}pt（DRY RUNのため未実行）`);
      } else {
        await adjustPoint(await freshKyouseiPage(), amount, sign);
        submitted = true;
        results.push(`ポイント：${sign}${amount}pt`);
      }
    }

    if (cmd.level) {
      if (DRY_RUN) {
        results.push(`レベル：${cmd.level}へ変更（DRY RUNのため未実行）`);
      } else {
        await setPointLevel(await freshKyouseiPage(), cmd.level);
        submitted = true;
        results.push(`レベル：${cmd.level}へ変更`);
      }
    }

    if (cmd.love) {
      if (DRY_RUN) {
        results.push(`絆レベル：キャラ${cmd.love.charaId} → value=${cmd.love.value}（DRY RUNのため未実行）`);
      } else {
        await setLoveLevel(page, uid, cmd.love.charaId, cmd.love.value);
        results.push(`絆レベル：キャラ${cmd.love.charaId} → value=${cmd.love.value}`);
      }
    }

    await kyouseiPage.close().catch(() => {});
    await lineBroadcast([`【会員操作完了】会員ID：${uid}`, ...results].join('\n'));
  } catch (err) {
    console.error('[MEMBER-CMD] エラー:', err.message, err.stack);
    await lineBroadcast([
      `【エラー】会員ID：${uid} の操作に失敗しました`,
      err.message,
      ...(results.length > 0 ? ['（完了済み）', ...results] : []),
    ].join('\n'));
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── コマンド処理の共通ロジック（LINE / Slack 両対応）───────────────
// text: 受信メッセージ本文
// reply: 即時応答を送る関数（LINEはlineReply、SlackはsendSlack）
// source: ログ表示用のソース名（'LINE' / 'SLACK'）
async function processCommand(text, reply, source = 'LINE') {
  console.log(`[${source}] 受信:`, JSON.stringify(text));

  // 停止コマンドは返信待ち中でも即座に効くよう、state file転送より先に判定する
  if (text === '停止') {
    stopReplies();
    stopContacts();
    stopSupport();
    return reply('全チェック処理を停止しました');
  }
  if (text === '返信チェック停止') {
    stopReplies();
    return reply('返信チェックを停止しました');
  }
  if (text === 'コンタクトチェック停止') {
    stopContacts();
    return reply('コンタクトチェックを停止しました');
  }

  // reply-checker.js/support-checker.js/contact-checker.js が返信待ち中なら
  // 受信テキストをそのままstate fileに書き込んで終了する。
  // 固定コマンド（開始/開始#〜/送信/手動対応/スキップ/調整する/変更する/差し込み#〜/差し替え#〜）に加え、
  // contact-checker.js/support-checker.js の処理コマンド
  // （開始 / 開始#補足 / 手動対応 / スキップ / レベル変更:〇 /
  //   メール確認 / 決済確認 / {数値}pt追加 / {数値}pt減算 /
  //   絆変更:{キャラID}:{value} の組み合わせ）や
  // contact-checker.js のSTEP6（返答内容の自由入力）、
  // 「会員:{uid} {操作コマンド}」形式の直接操作コマンド、
  // 「返信対象外チェック」「対象外ID:{番号} {返信文章}」にも対応するため、
  // waiting状態であれば内容を問わず転送する（＝「開始」「開始#〜」「会員:〜」
  // 「返信対象外チェック」「対象外ID:〜」もそのままstate fileへ書き込まれる。
  // これにより対象外返信の確認待ち中の「送信」「スキップ」も転送される）
  if (fs.existsSync(REPLY_STATE_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(REPLY_STATE_FILE, 'utf8'));
      if (state.status === 'waiting') {
        fs.writeFileSync(REPLY_STATE_FILE, JSON.stringify({ status: 'replied', reply: text }));
        return;
      }
    } catch (_) {}
  }

  // ─── 「返信対象外チェック」───────────────────────────────────
  // 直近の返信チェックでSKIPになったユーザーと理由を一覧通知する
  if (text === '返信対象外チェック') {
    return reply(buildSkippedUsersMessage());
  }

  // ─── 「対象外ID:{番号} ...」対象外ユーザーへの手動返信・本文照会 ─────────
  // 返信チェック完了時に通知した対象外一覧の番号を指定する。番号→uid/kidの
  // 解決は reply-checker側で /tmp/rune-skipped-list.json を読んで行う。
  //  ・「対象外ID:{番号} 本文照会」→ ユーザーメッセージを照会（送信なし）
  //  ・「対象外ID:{番号} 次行:{文章}」→ 次のコメントアウトを付与して送信
  //  ・「対象外ID:{番号} {文章}」    → 最終コメントアウトと同一のものを付与して送信
  // 判定順は 本文照会 → 次行 → 通常。処理には時間がかかりreplyTokenが失効するため、
  // 受付だけ即返信し、確認通知・完了/エラーはreply-checker側のsendLineで通知する。
  // 確認返信（「送信」「スキップ」）は返信待ち中のstate file転送で
  // sendManualReply内のwaitForLineReplyへ渡る。
  const bunshoMatch = text.match(/^対象外ID[:：]\s*(\d+)\s+本文照会$/);
  const nextMatch   = text.match(/^対象外ID[:：]\s*(\d+)\s+次行[:：]\s*([\s\S]+)$/);
  const normalMatch = text.match(/^対象外ID[:：]\s*(\d+)\s+([\s\S]+)$/);
  if (bunshoMatch) {
    const index = bunshoMatch[1];
    console.log(`[${source}] 本文照会: 対象外ID=${index}`);
    inquireUserBody(index, rcSendLine)
      .catch(err => console.error('[本文照会] 実行エラー:', err.message));
    return reply(`【本文照会】対象外ID：${index}\n照会を開始しました`);
  }
  if (nextMatch) {
    const index = nextMatch[1];
    const replyText = nextMatch[2].trim();
    console.log(`[${source}] 対象外返信(次行): 対象外ID=${index} text="${replyText.slice(0, 40)}"`);
    sendManualReply(index, replyText, rcSendLine, rcWaitForLineReply, process.env.DRY_RUN === 'true', true)
      .catch(err => console.error('[MANUAL-REPLY] 実行エラー:', err.message));
    return reply(`【対象外返信】対象外ID：${index}\n処理を開始しました（次のコメントアウト）`);
  }
  if (normalMatch) {
    const index = normalMatch[1];
    const replyText = normalMatch[2].trim();
    console.log(`[${source}] 対象外返信: 対象外ID=${index} text="${replyText.slice(0, 40)}"`);
    sendManualReply(index, replyText, rcSendLine, rcWaitForLineReply, process.env.DRY_RUN === 'true', false)
      .catch(err => console.error('[MANUAL-REPLY] 実行エラー:', err.message));
    return reply(`【対象外返信】対象外ID：${index}\n処理を開始しました`);
  }

  // ─── 「会員:{uid} {操作コマンド}」直接操作 ───────────────────────
  // 処理には時間がかかりreplyTokenが失効するため、受付だけ即返信し、
  // 実行結果はブロードキャストで通知する
  const memberMatch = text.match(/^会員:(\d+)\s+(.+)$/);
  if (memberMatch) {
    const uid = memberMatch[1];
    const command = memberMatch[2].trim();
    console.log(`[${source}] 会員直接操作: uid=${uid} command="${command}"`);
    runMemberCommand(uid, command)
      .catch(err => console.error('[MEMBER-CMD] 実行エラー:', err.message));
    return reply(`【会員操作】会員ID：${uid}\nコマンド：${command}\n処理を開始しました`);
  }

  // ─── 「{uid} {金額}円 入金」手動入金処理 ─────────────────────────
  // 例:「1042287 10000円 入金」
  // 入金メール（mail-checker.js）と同じロジック（utils.js の processPayment）で
  // ポイントを付与する。処理には時間がかかりreplyTokenが失効するため、
  // 受付だけ即返信し、結果はブロードキャストで通知する。
  // ※チェッカーが返信待ち中の場合は上のstate file転送で先にチェッカーへ渡るため、
  //   ここに来るのはチェッカー非稼働時（単独コマンド）のみ
  const paymentMatch = text.match(/^(\d+)\s+([\d,]+)円\s+入金$/);
  if (paymentMatch) {
    const uid = paymentMatch[1];
    const amount = parseInt(paymentMatch[2].replace(/,/g, ''), 10);
    console.log(`[${source}] 手動入金処理: uid=${uid} amount=${amount}円`);
    const { runPaymentCommand } = require('./utils');
    runPaymentCommand(uid, amount, lineBroadcast, process.env.DRY_RUN === 'true')
      .catch(err => console.error('[PAYMENT-CMD] 実行エラー:', err.message));
    return reply(`【入金処理】会員ID：${uid}\n入金額：${amount}円\n処理を開始しました`);
  }

  // ─── 「{コメントアウト} 検索」同一コメントアウトグループへの一括送信 ─────
  // 例:「12686yu1/sinko/1 検索」→ 最新コメントアウトが完全一致する会員を抽出し、
  // 次の行の文章を一括送信の確認・送信対象とする。処理には時間がかかり
  // replyTokenが失効するため、受付だけ即返信し、確認通知・完了/エラーは
  // reply-checker側のsendLineで通知する。確認返信（「送信」「除外:… 送信」
  // 「スキップ」）は返信待ち中のstate file転送でwaitForLineReplyへ渡る。
  // ※コメントアウトは必ず「/」を含むため、誤検出防止に「/」を含む語のみ対象とする
  const searchMatch = text.match(/^(\S+\/\S+)\s+検索$/);
  if (searchMatch) {
    const searchComment = searchMatch[1].trim();
    console.log(`[${source}] 一括検索送信: コメントアウト="${searchComment}"`);
    batchSearchAndReply(searchComment, rcSendLine, rcWaitForLineReply, process.env.DRY_RUN === 'true')
      .catch(err => console.error('[BATCH-SEARCH] 実行エラー:', err.message));
    return reply(`【一括送信】コメントアウト：${searchComment}\n該当グループの検索を開始しました`);
  }

  if (text === '返信チェック開始') {
    if (isReplyCheckerRunning) {
      return reply('【返信チェック】既に動作中です');
    }
    isReplyCheckerRunning = true;
    checkReplies()
      .catch(err => console.error('[REPLY] エラー:', err.message))
      .finally(() => { isReplyCheckerRunning = false; });
    return reply('返信チェックを開始しました');
  }

  if (text === 'サポートチェック開始') {
    checkSupport().catch(err => console.error('[SUPPORT] エラー:', err.message));
    return reply('サポートチェックを開始しました');
  }

  if (text === 'コンタクトチェック開始') {
    if (isContactCheckerRunning) {
      return reply('【コンタクトチェック】既に動作中です');
    }
    isContactCheckerRunning = true;
    checkContacts()
      .catch(err => console.error('[CONTACT] エラー:', err.message))
      .finally(() => { isContactCheckerRunning = false; });
    return reply('コンタクトチェックを開始しました');
  }

  if (text === 'ステータス') {
    return reply(isMailCheckRunning() ? '入金処理稼働中' : '入金処理停止中');
  }

  // 未対応メッセージはエコー返信
  return reply('受け取りました：' + text);
}

// ─── LINE Webhook からのイベントを共通ロジックへ渡す ────────────────
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const text = event.message.text.trim();
  const replyToken = event.replyToken;
  return processCommand(text, (msg) => lineReply(replyToken, msg), 'LINE');
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // LINEは即時200が必要
  const events = req.body.events || [];
  await Promise.all(events.map(handleEvent));
});

// ─── Slack Event API 署名検証 ─────────────────────────────────────
// https://api.slack.com/authentication/verifying-requests-from-slack
// v0:{timestamp}:{生ボディ} を SLACK_SIGNING_SECRET でHMAC-SHA256し、
// X-Slack-Signature ヘッダー（v0=...）と一致するか検証する
function verifySlackSignature(req) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    console.warn('[SLACK] SLACK_SIGNING_SECRET が未設定のため検証できません');
    return false;
  }
  const signature = req.headers['x-slack-signature'];
  const timestamp = req.headers['x-slack-request-timestamp'];
  if (!signature || !timestamp) return false;

  // リプレイ攻撃対策: 5分以上前のリクエストは拒否する
  const fiveMinutes = 60 * 5;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > fiveMinutes) {
    console.warn('[SLACK] タイムスタンプが古すぎます');
    return false;
  }

  const body = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex');
  const expected = `v0=${hmac}`;

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

// ─── Slackメッセージイベントの共通処理 ─────────────────────────────
// Socket Mode / Request URL のどちらで受信しても同じ処理を通す。
// event: Slack Events API の event オブジェクト
async function handleSlackMessageEvent(event) {
  if (!event) return;

  // メッセージイベントのみ処理する
  // ・event.bot_id あり → ボット自身/他ボットの発言なので無視（無限ループ防止）
  // ・event.subtype あり → メッセージ編集/参加通知など通常発言以外なので無視
  // ※人間からの通常発言には bot_id も subtype も付かないため除外されない
  if (event.type !== 'message' || event.bot_id || event.subtype) {
    console.log('[SLACK] 対象外のイベントのため無視:',
      { type: event.type, bot_id: event.bot_id, subtype: event.subtype });
    return;
  }

  const text = (event.text || '').trim();
  if (!text) return;

  console.log(`[SLACK] コマンド処理へ渡します channel=${event.channel} user=${event.user} text=${JSON.stringify(text)}`);

  try {
    // コマンド実行結果は sendSlack() で通知する
    await processCommand(text, (msg) => sendSlack(msg), 'SLACK');
  } catch (err) {
    console.error('[SLACK] コマンド処理エラー:', err.message);
  }
}

// ─── Slack Socket Mode 受信 ───────────────────────────────────────
// Slack App側で Socket Mode = ON にしたため、Slackからのイベントは
// 公開Request URL（POST /slack/events）ではなくWebSocket経由で届く。
// 接続にはApp-Level Token（xapp-... / connections:write）が必要。
//   SLACK_APP_TOKEN  … Socket Mode接続専用（xapp-...）
//   SLACK_BOT_TOKEN  … Bot APIの呼び出し用（chat:write / channels:history）
//   SLACK_WEBHOOK_URL… VPS→Slackの既存通知用（sendSlack）
// ※ Request URL方式の POST /slack/events は既存機能への影響を避けるため
//    残してあるが、Socket Mode有効時はSlackからHTTP送信されない。
let slackSocket = null;

function startSlackSocketMode() {
  const appToken = process.env.SLACK_APP_TOKEN;
  if (!appToken) {
    console.warn('[SLACK] SLACK_APP_TOKEN が未設定のため Socket Mode を開始しません');
    return;
  }
  if (!appToken.startsWith('xapp-')) {
    console.warn('[SLACK] SLACK_APP_TOKEN が xapp- で始まっていません（App-Level Tokenを設定してください）');
  }
  if (!process.env.SLACK_BOT_TOKEN) {
    console.warn('[SLACK] SLACK_BOT_TOKEN が未設定です（Bot API利用時は設定が必要）');
  }

  let SocketModeClient;
  try {
    ({ SocketModeClient } = require('@slack/socket-mode'));
  } catch (e) {
    console.error('[SLACK] @slack/socket-mode のロードに失敗しました（npm install が必要です）:', e.message);
    return;
  }

  slackSocket = new SocketModeClient({ appToken });

  // 受信できない場合の切り分け用に接続状態をログ出力する
  slackSocket.on('authenticated', () => console.log('[SLACK] Socket Mode 認証成功'));
  slackSocket.on('connected',     () => console.log('[SLACK] Socket Mode 接続完了（イベント受信待機中）'));
  slackSocket.on('reconnecting',  () => console.warn('[SLACK] Socket Mode 再接続中...'));
  slackSocket.on('disconnected',  () => console.warn('[SLACK] Socket Mode 切断されました'));

  // 全イベントをここで受ける（type別ハンドラとの二重ack を避けるため一本化）
  slackSocket.on('slack_event', async ({ ack, type, body }) => {
    // Slackは3秒以内にackが無いとリトライするため、処理より先にackを返す
    try {
      await ack();
    } catch (e) {
      console.error('[SLACK] ack送信エラー:', e.message);
    }

    if (type !== 'events_api') {
      console.log(`[SLACK] Socket Mode 受信（Events API以外のため未処理）: type=${type}`);
      return;
    }

    const event = body?.event;
    console.log(`[SLACK] Socket Mode 受信: event.type=${event?.type} channel=${event?.channel}`);

    // message.channels 以外（app_home_opened など）はackのみで終了する
    if (event?.type !== 'message') return;

    await handleSlackMessageEvent(event);
  });

  slackSocket.start()
    .then(() => console.log('[SLACK] Socket Mode を開始しました'))
    .catch(err => console.error('[SLACK] Socket Mode 開始エラー:', err.message));
}

// ─── Slack Event API エンドポイント（Request URL方式・互換用）───────
// Socket Mode有効時はSlackから呼ばれないが、既存機能への影響を避けるため残す
app.post('/slack/events', async (req, res) => {
  console.log('[SLACK] リクエスト受信:', req.headers['user-agent'], req.body);

  // URL検証チャレンジ（Slack App登録時のエンドポイント確認）
  if (req.body && req.body.type === 'url_verification') {
    return res.status(200).send(req.body.challenge);
  }

  // 署名検証
  console.log('[SLACK] 署名検証開始');
  const result = verifySlackSignature(req);
  console.log('[SLACK] 署名検証結果:', result);
  if (!result) {
    console.warn('[SLACK] 署名検証に失敗しました');
    return res.sendStatus(401);
  }

  res.sendStatus(200); // Slackは3秒以内の200が必要（以降は非同期処理）

  // 受信方式が違うだけで、以降の処理はSocket Modeと共通
  await handleSlackMessageEvent(req.body.event);
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
  startMailCheck();
  console.log('[MAIL] 入金処理を自動開始しました');
  // SlackイベントはSocket Mode（WebSocket）で受信する
  startSlackSocketMode();
});
server.on('error', (err) => {
  console.error('[SERVER] listenエラー:', err.message);
});

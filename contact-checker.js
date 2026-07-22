'use strict';

/**
 * contact-checker.js
 * mg_contactMail.php の未処理コンタクトメール一覧を取得し、
 * LINEで返答内容を確認しながらPlaywrightで送信するスクリプト
 *
 * 配置場所: /root/rune-bot/contact-checker.js
 * 実行: node contact-checker.js  または  server.js から checkContacts() を呼ぶ
 *
 * 【処理フロー】
 *   STEP1: mg_contactMail.php を開く（メインページのリンクをクリック）
 *   STEP2: 「実行」ボタンをクリックして一覧を表示
 *   STEP3: background-color: #ffaaaa の行を未処理として取得
 *   STEP4: mg_mail_contact.php?u_mail=&uid={uid}（「スレッド確認」の
 *          実際の遷移先）を新しいページとして開き、
 *          スレッド内の最新メッセージを取得
 *   STEP4.5: 問い合わせ内容にポイント関連キーワードが含まれる場合のみ、
 *          uidの本日配信メールからキャンペーンを解析し、割引率チェック
 *          （utils.jsのcheckAndApplyDiscount）と入金額に対するポイント差異
 *          チェック（utils.jsのcheckPointDiff、差異があれば「調整する」で
 *          調整）を行う（support-checker.jsのSTEP4-6・11-15相当）
 *   STEP4.6: contact-templates.json のテンプレートにClaude APIで
 *          自動マッチングを試みる。一致すればLINEで送信確認のみ行い、
 *          「送信」ならそのまま送信して次のコンタクトへ
 *          （「スキップ」・未一致・タイムアウトなら手動対応フローへ）
 *   STEP5: LINEに問い合わせ内容を通知し、返答内容の入力を依頼
 *   STEP6: LINEからの返答を受け取る（5分タイムアウト、「スキップ」で次へ）
 *   STEP7: テンプレートに差し込んだ送信内容をLINEで確認
 *   STEP8: 「送信」の場合、STEP4で開いたthreadPageのフォーム
 *          （input#messTempTitle等）に入力して送信
 *
 * 【LINE返信待ちの仕組み】
 *   reply-checker.js と同じ /tmp/rune-reply-state.json を共有し、
 *   server.js の LINE webhook からの返信をポーリングで検知する（タイムアウト5分）
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk').default;
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const {
  openKyouseitaikai, adjustPoint, setPointLevel, getPointLevel, checkAndApplyDiscount,
  getMailRows, getBankHistory, checkPointDiff,
} = require('./utils');

const LOGIN_URL  = process.env.SYSTEM_URL || 'http://manager.x7j4l2p9m1.com/mg/mg_ope.php';
const BASE_URL   = LOGIN_URL.replace(/[^/]+$/, ''); // "http://manager.x7j4l2p9m1.com/mg/"
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DRY_RUN    = process.env.DRY_RUN === 'true';

const CONTACT_TEMPLATES_PATH = path.join(__dirname, 'contact-templates.json');
const claudeClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// reply-checker.js と同じstate fileを共有する（同時稼働はしない前提）
const STATE_FILE = '/tmp/rune-reply-state.json';
const POLL_INTERVAL_MS = 2000;
const REPLY_TIMEOUT_MS = 5 * 60 * 1000; // 5分

let _shouldStop = false;

// ─── LINE 送信 ────────────────────────────────────────────────────

async function sendLine(message) {
  const MAX_RETRY = 3;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      await axios.post(
        'https://api.line.me/v2/bot/message/broadcast',
        { messages: [{ type: 'text', text: message }] },
        { headers: { Authorization: `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      await new Promise(r => setTimeout(r, 2000)); // 429対策: 送信後2秒待機
      return;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < MAX_RETRY) {
        console.warn(`[LINE] 429 Too Many Requests → 10秒待ってリトライ (${attempt}/${MAX_RETRY})`);
        await new Promise(r => setTimeout(r, 10000));
      } else {
        console.error(`[LINE] 送信エラー (attempt ${attempt}):`, err.message);
        return;
      }
    }
  }
}

// ─── LINE 返信待ち（ファイルポーリング）─────────────────────────────

function setWaiting() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ status: 'waiting', reply: null }));
}

function clearState() {
  try { fs.unlinkSync(STATE_FILE); } catch (_) {}
}

function waitForLineReply() {
  return new Promise((resolve, reject) => {
    setWaiting();
    const start = Date.now();
    const timer = setInterval(() => {
      if (_shouldStop) {
        clearInterval(timer);
        clearState();
        reject(new Error('停止要求'));
        return;
      }
      try {
        if (!fs.existsSync(STATE_FILE)) return;
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (state.status === 'replied' && state.reply) {
          clearInterval(timer);
          clearState();
          resolve(state.reply);
          return;
        }
      } catch (_) {}
      if (Date.now() - start > REPLY_TIMEOUT_MS) {
        clearInterval(timer);
        clearState();
        reject(new Error('タイムアウト'));
      }
    }, POLL_INTERVAL_MS);
  });
}

// ─── Playwright: ログイン ─────────────────────────────────────────

async function login(page) {
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
  console.log('[LOGIN] タイトル:', await page.title());

  // セッション切れ対応（reply-checker.js と同じ方法）
  const sessionLink = page.locator('a[href*="s_system"]');
  if (await sessionLink.count() > 0) {
    console.log('[LOGIN] セッション切れ検知 → クリック');
    await sessionLink.first().click();
    await page.waitForLoadState('networkidle');
  }

  await page.fill('[name="id"]',    process.env.SYSTEM_LOGIN_ID);
  await page.fill('[name="pass"]',  process.env.SYSTEM_LOGIN_PASS);
  await page.click('[name="login"]');
  await page.waitForLoadState('networkidle');
  console.log('[LOGIN] 完了:', await page.title());
}

// ─── STEP1: mg_contactMail.php を開く ───────────────────────────────
// リンクのクリックは不安定なため、直接URLへ遷移する

async function openContactMailPage(page) {
  const url = BASE_URL + 'mg_contactMail.php';
  console.log(`[STEP1] mg_contactMail.php を開く: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle' });
  return page;
}

// ─── STEP2: 「実行」ボタンをクリック ─────────────────────────────────

async function runContactSearch(contactPage) {
  console.log('[STEP2] 「実行」ボタンをクリック');
  await contactPage.click('input[type="submit"][value="実行"]');
  await contactPage.waitForLoadState('networkidle').catch(() => {});
  await new Promise(r => setTimeout(r, 1000));
}

// ─── STEP3: 未処理一覧（background-color: #ffaaaa の行）を取得 ────────
// 列は1始まりの表記に対応: 2列目=受信日時、3列目=会員ID、
// 4列目=ユーザーネーム（aタグ）、7列目=問い合わせ文頭、8列目=スレッド確認リンク

async function getUnprocessedContacts(contactPage) {
  const contacts = await contactPage.evaluate(() => {
    function normStyle(el) {
      return (el.getAttribute('style') || '').replace(/\s/g, '').toLowerCase();
    }

    const results = [];
    for (const tr of document.querySelectorAll('tr')) {
      const cells = Array.from(tr.querySelectorAll('td'));
      if (cells.length < 8) continue;

      const trIsPink = normStyle(tr).includes('background-color:#ffaaaa');
      const cellIsPink = cells.some(td => normStyle(td).includes('background-color:#ffaaaa'));
      if (!trIsPink && !cellIsPink) continue;

      const datetime = (cells[1].textContent || '').trim(); // 2列目
      const uid = (cells[2].textContent || '').trim();      // 3列目
      const userLink = cells[3].querySelector('a');          // 4列目のaタグ
      const username = userLink ? userLink.textContent.trim() : (cells[3].textContent || '').trim();
      const preview = (cells[6].textContent || '').trim();   // 7列目
      const threadLink = cells[7].querySelector('a');         // 8列目のaタグ
      const threadHref = threadLink ? threadLink.getAttribute('href') : null;
      if (!threadHref) continue;

      results.push({ datetime, uid, username, preview, threadHref });
    }
    return results;
  });

  console.log(`[STEP3] 未処理行数: ${contacts.length}`);
  contacts.forEach((c, i) => console.log(`[DEBUG] contact[${i}]: uid=${c.uid} username=${c.username} datetime=${c.datetime} threadHref=${c.threadHref}`));
  return contacts;
}

// ─── STEP4: mg_mail_contact.php を新しいページとして開き最新メッセージを取得 ──
// 「スレッド確認」リンクの実際の遷移先は mg_mail_contact.php?u_mail=&uid={uid}
// であることが判明したため、そのURLを直接新しいページとして開く

async function openContactThread(contactPage, uid) {
  const url = `${BASE_URL}mg_mail_contact.php?u_mail=&uid=${encodeURIComponent(uid)}`;
  console.log(`[STEP4] mg_mail_contact.php を新しいページで開く: ${url}`);

  const threadPage = await contactPage.context().newPage();
  await threadPage.goto(url, { waitUntil: 'networkidle' }).catch(async () => {
    await threadPage.goto(url).catch(() => {});
  });

  console.log('[STEP4] 遷移後URL:', threadPage.url());
  return threadPage;
}

// STEP4で開いたthreadPage（mg_mail_contact.php）から全メッセージ本文を取得する。
// background-color: #aaaaffのtr内のtextarea（name="mess[...]"）から
// 各メッセージの本文を取得し、"---"区切りで連結する
async function getLatestThreadMessage(page, previewText) {
  try {
    const inquiries = await page.evaluate(() => {
      const rows = document.querySelectorAll('tr[style*="aaaaff"]');
      return Array.from(rows).map(tr => {
        const textarea = tr.querySelector('textarea[name^="mess["]');
        return textarea ? textarea.value.trim() : '';
      }).filter(t => t.length > 0);
    });
    if (inquiries.length > 0) {
      const fullText = inquiries.join('\n---\n');
      console.log(`[STEP4] スレッド本文取得: ${inquiries.length}件 "${fullText.slice(0, 60)}..."`);
      return fullText;
    }
  } catch (e) {
    console.log('[STEP4] 問い合わせ内容の取得に失敗:', e.message);
  }
  console.log('[STEP4] 本文取得に失敗/0件 → 一覧の問い合わせ文頭にフォールバック');
  return previewText;
}

// STEP8用: 指定した候補セレクターを順に試し、最初に見つかった要素に入力する。
// input#messTempTitleがタイムアウトするケースに備え、代替セレクターへ
// フォールバックする。1候補あたりの待機は短めにして無駄なタイムアウトの
// 積み重ねを防ぐ
async function fillFirstAvailable(page, selectors, value, timeoutPerSelector = 5000) {
  for (const sel of selectors) {
    try {
      const locator = page.locator(sel).first();
      await locator.waitFor({ state: 'visible', timeout: timeoutPerSelector });
      await locator.fill(value);
      console.log(`[STEP8] セレクター "${sel}" に入力成功`);
      return true;
    } catch (e) {
      console.log(`[STEP8] セレクター "${sel}" が見つからずタイムアウト → 次候補`);
    }
  }
  return false;
}

// ─── STEP7で使う送信本文の組み立て ────────────────────────────────

function buildContactReplyBody(answerText) {
  return [
    'お問い合わせ頂きました内容についての回答をさせて頂きます。',
    answerText,
    'その他、ご不明な点やご質問など御座いましたらお気軽にお問合せ窓口までお問い合わせ下さい。',
    'RUNEお問い合わせ窓口',
  ].join('\n');
}

// ─── HTML本文からキャンペーン内容を抽出・解析（support-checker.js の ────
// parseCampaignWithClaude と同じロジック、claudeClientを使用）
const CAMPAIGN_SYSTEM_PROMPT =
  'あなたはメール本文からキャンペーン情報を抽出するアシスタントです。JSONのみで回答してください。';

const CAMPAIGN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    campaigns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['fixed', 'rate', 'percent', 'discount'] },
          amount: { type: 'integer' },
          bonus: { type: 'integer' },
          rate: { type: 'number' },
          discount: { type: 'integer' },
          unit: { type: 'string' },
        },
        required: ['type', 'amount', 'unit'],
        additionalProperties: false,
      },
    },
  },
  required: ['campaigns'],
  additionalProperties: false,
};

function buildCampaignUserPrompt(bodyHtml) {
  return `以下のメール本文からキャンペーン内容を抽出してください。
購入金額と付与ポイント/倍率/割引の対応表をJSON形式で返してください。

購入金額によって補助率が異なる場合は、条件ごとに分けてください。
例：100,000円購入時は100%、それ以下は50%の場合は別々に記載してください。

ボーナスくじ、ボーナスルーレット、MAXボーナスルーレットなど
抽選形式の特典は除外してください。

同じ購入金額帯が複数ある場合は最も有利な条件のみ残してください。

${bodyHtml}

以下のJSON形式で返してください：
{
  "campaigns": [
    {"type": "fixed", "amount": 10000, "bonus": 5000, "unit": "円分"},
    {"type": "rate", "amount": 3000, "rate": 1.2, "unit": "倍"},
    {"type": "percent", "amount": 0, "rate": 50, "unit": "%"},
    {"type": "discount", "amount": 0, "discount": 30, "unit": "pt"}
  ]
}`;
}

async function parseCampaignWithClaude(bodyHtml) {
  if (!bodyHtml) return [];

  try {
    const response = await claudeClient.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 8192,
      thinking: { type: 'adaptive' },
      system: CAMPAIGN_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildCampaignUserPrompt(bodyHtml) }],
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: CAMPAIGN_JSON_SCHEMA },
      },
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) {
      console.log('[CAMPAIGN] Claude APIレスポンスにテキストブロックがありません');
      return [];
    }

    const parsed = JSON.parse(textBlock.text);
    const campaigns = Array.isArray(parsed.campaigns) ? parsed.campaigns : [];
    console.log(`[CAMPAIGN] Claude API解析結果: ${campaigns.length}件`);
    return campaigns;
  } catch (e) {
    console.error('[ERROR] Claude APIキャンペーン解析失敗:', e.message);
    return [];
  }
}

// ─── STEP4.5: uidのキャンペーン・入金状況を確認し割引率/ポイント差異をチェック ──
// support-checker.jsのSTEP4-6(お知らせメール取得)・STEP11-14(銀行振込履歴取得)・
// STEP15(ポイント差異チェック)・checkAndApplyDiscountと同じ処理をuidベースで行う。
// 実在ユーザーの所持ポイントを変更する処理を含むため、DRY_RUN=trueの間は
// 銀行振込履歴取得（+1加算を含む）以降を一切実行しない
async function checkCampaignAndPoints(page, contact) {
  let kyouseiPage;
  try {
    kyouseiPage = await openKyouseitaikai(page, contact.uid);
  } catch (e) {
    console.log(`[CAMPAIGN] uid=${contact.uid}: 会員詳細ページを開けませんでした: ${e.message}`);
    return;
  }

  try {
    const mailRows = await getMailRows(kyouseiPage);
    console.log(`[CAMPAIGN] uid=${contact.uid}: 本日配信メール ${mailRows.length}件`);
    if (mailRows.length === 0) return;

    const mails = [];
    for (let i = 0; i < mailRows.length; i++) {
      const row = mailRows[i];
      const campaigns = await parseCampaignWithClaude(row.bodyHtml);
      console.log(`[CAMPAIGN] uid=${contact.uid} メール${i + 1} "${row.title}": ${campaigns.length}件検出`);
      mails.push({ title: row.title || `メール${i + 1}`, campaigns });
    }
    const allCampaigns = mails.flatMap(m => m.campaigns);
    if (allCampaigns.length === 0) return;

    if (DRY_RUN) {
      console.log(`[DRY RUN] uid=${contact.uid}: 銀行振込履歴取得・割引/ポイント差異チェックをスキップ`);
      return;
    }

    const { bankRows, historyPage } = await getBankHistory(page, kyouseiPage);
    console.log(`[CAMPAIGN] uid=${contact.uid}: 銀行振込履歴 ${bankRows.length}件`);
    if (bankRows.length === 0) return;

    const totalAmount = bankRows.reduce((sum, r) => sum + r.amount, 0);

    try {
      await checkAndApplyDiscount(page, contact.uid, allCampaigns, totalAmount, sendLine, waitForLineReply, DRY_RUN);
    } catch (e) {
      console.log(`[DISCOUNT] uid=${contact.uid}: 割引率チェックに失敗: ${e.message}`);
    }

    const { diff, reply } = await checkPointDiff(allCampaigns, bankRows, sendLine, waitForLineReply, DRY_RUN);
    if (diff !== 0 && reply === '調整する') {
      if (historyPage !== kyouseiPage) {
        await historyPage.close().catch(() => {});
      } else {
        await kyouseiPage.evaluate(() => window.history.back());
        await new Promise(r => setTimeout(r, 2000));
      }
      const sign = diff < 0 ? '+' : '-';
      const diffAbs = Math.abs(diff);
      await adjustPoint(kyouseiPage, diffAbs, sign);
      await sendLine(`【調整完了】uid=${contact.uid}のポイントを${sign}${diffAbs}pt調整しました`);
    }
  } catch (e) {
    console.log(`[CAMPAIGN] uid=${contact.uid}: キャンペーン/ポイントチェックに失敗: ${e.message}`);
  } finally {
    await kyouseiPage.close().catch(() => {});
  }
}

// ─── STEP4.6: contact-templates.json からテンプレートIDをClaude APIで判定 ──
// 該当なし・判定失敗時はnullを返し、呼び出し側は既存の手動対応フローへ進む
async function matchTemplate(inquiryText) {
  const response = await claudeClient.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 100,
    system: 'テンプレートIDのみをJSON形式で返してください。',
    messages: [{
      role: 'user',
      content: `以下の問い合わせに最も近いテンプレートIDを返してください。
該当なしの場合はnullを返してください。

テンプレートID一覧：
withdraw: 退会したい・退会申請
mail_open: メールが開けない・メールが見れない・メールボックスが開かない
no_reply: 先生から返事が来ない・返信がない・連絡がない
unclear: 問い合わせ内容が意味不明・何を聞いているかわからない
message_to_teacher: 先生への伝言・先生に伝えてほしい
login: ログインできない・サイトに入れない
point_purchase: ポイントの買い方・購入方法・決済方法を知りたい
free_period: 無料期間はいつまでか・無料はどのくらいか
discount_ticket: 割引チケット・ガチャチケット・クーポンの使い方

ポイントの残高・計算・反映などに関する問い合わせはnullを返してください。
購入方法を聞いている場合のみpoint_purchaseを選択してください。

問い合わせ内容：${inquiryText}

{"templateId": "ID"} の形式で返してください。`,
    }],
  });

  const text = (response.content.find(b => b.type === 'text')?.text ?? '').trim();
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  return parsed.templateId || null;
}

// STEP8 / 自動返答で共通の送信処理（件名・本文を入力してgotoHeavenをクリック）
// 成功時はtrue、失敗時はfalseを返す
async function submitContactReply(threadPage, bodyText, uid, label) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] ${label}送信をスキップ: uid=${uid}`);
    await sendLine(`【DRY RUN】uid=${uid}への${label}送信をスキップしました`);
    return true;
  }

  console.log('[DEBUG] 送信前URL:', threadPage.url());

  const titleFilled = await fillFirstAvailable(
    threadPage,
    ['input#messTempTitle', 'input[name="title"]', '#messTempTitle'],
    'RUNEインフォメーションです。'
  );
  if (!titleFilled) {
    console.log(`[ERROR] uid=${uid}: 件名入力欄が見つかりません（現在URL: ${threadPage.url()}）`);
    await sendLine(`【エラー】uid=${uid}: 件名入力欄が見つからず送信できませんでした`);
    return false;
  }

  await threadPage.fill('textarea#messTempBody', bodyText);
  await threadPage.click('input#gotoHeaven');
  await threadPage.waitForLoadState('networkidle').catch(() => {});
  console.log(`[SEND] uid=${uid} ${label}送信完了`);
  await sendLine(`【送信完了】uid=${uid}へ${label}を送信しました`);
  return true;
}

// ─── コンタクト処理メインループ ───────────────────────────────────

async function processContacts(page) {
  const contactPage = await openContactMailPage(page);
  await runContactSearch(contactPage);
  const contacts = await getUnprocessedContacts(contactPage);
  console.log(`[LIST] 未処理コンタクト: ${contacts.length}件`);

  if (contacts.length === 0) {
    await sendLine('未処理のコンタクトメールはいませんでした');
    return;
  }

  for (const contact of contacts) {
    if (_shouldStop) {
      console.log('[STOP] 停止要求により中断');
      break;
    }

    console.log(`[CONTACT] 確認中: uid=${contact.uid} username=${contact.username}`);

    // ─── STEP4 ──────────────────────────────────────────────────
    // 新しいページとして開くため、処理後は必ずclose()する（try/finally）
    const threadPage = await openContactThread(contactPage, contact.uid);
    try {
      const content = await getLatestThreadMessage(threadPage, contact.preview);

      // ─── STEP4.5: キャンペーン・ポイント確認（割引率チェック含む） ──
      // 問い合わせ内容にポイント関連キーワードが含まれる場合のみ実行する
      const pointKeywords = ['ポイント', 'pt', 'PT', '割引', 'キャンペーン', '入金', '購入', '反映'];
      const hasPointRelated = pointKeywords.some(k => content.includes(k));
      if (hasPointRelated) {
        console.log(`[CAMPAIGN] uid=${contact.uid}: ポイント関連キーワード検出 → STEP4.5を実行`);
        try {
          await checkCampaignAndPoints(page, contact);
        } catch (e) {
          console.log(`[CAMPAIGN] uid=${contact.uid}: STEP4.5に失敗: ${e.message}`);
        }
      } else {
        console.log(`[CAMPAIGN] uid=${contact.uid}: ポイント関連キーワードなし → STEP4.5をスキップ`);
      }

      // ─── STEP4.6: テンプレート自動判定 ─────────────────────────
      let templateId = null;
      try {
        templateId = await matchTemplate(content);
      } catch (e) {
        console.log(`[TEMPLATE] uid=${contact.uid}: テンプレート判定に失敗: ${e.message}`);
      }
      console.log(`[TEMPLATE] uid=${contact.uid}: templateId=${templateId}`);

      if (templateId) {
        const templates = JSON.parse(fs.readFileSync(CONTACT_TEMPLATES_PATH, 'utf8')).templates;
        const template = templates.find(t => t.id === templateId);
        if (!template) {
          console.log(`[TEMPLATE] uid=${contact.uid}: templateId="${templateId}" に一致するテンプレートが見つかりません`);
        } else {
          await sendLine([
            '【自動返答候補】',
            `テンプレート：${template.id}`,
            '---',
            template.response,
            '---',
            '「送信」：そのまま送信',
            '「スキップ」：手動対応へ',
          ].join('\n'));

          let autoReply = null;
          try {
            autoReply = await waitForLineReply();
          } catch (e) {
            console.log(`[TIMEOUT] uid=${contact.uid}: 自動返答確認 5分タイムアウト → 手動対応へ`);
          }
          console.log(`[LINE] 自動返答確認返信: ${autoReply}`);

          if (autoReply === '送信') {
            await submitContactReply(threadPage, template.response, contact.uid, `自動返答（${template.id}）`);
            continue;
          }
          console.log(`[TEMPLATE] uid=${contact.uid}: 自動返答をスキップ → 手動対応フローへ`);
        }
      }

      // ─── STEP5 ────────────────────────────────────────────────
      await sendLine([
        '【コンタクトメール】',
        `会員ID：${contact.uid}`,
        `ユーザー：${contact.username}`,
        `受信日時：${contact.datetime}`,
        '---',
        content,
        '---',
        '返答内容を入力してください',
        '（スキップする場合は「スキップ」）',
      ].join('\n'));

      // ─── STEP6 ────────────────────────────────────────────────
      let answer;
      try {
        answer = await waitForLineReply();
      } catch (e) {
        console.log(`[TIMEOUT] uid=${contact.uid}: 5分タイムアウト → スキップ`);
        continue;
      }
      console.log(`[LINE] 返答内容: ${answer}`);

      if (answer === 'スキップ') {
        console.log(`[SKIP] uid=${contact.uid} スキップ`);
        continue;
      }

      // ─── STEP7 ────────────────────────────────────────────────
      const bodyText = buildContactReplyBody(answer);
      await sendLine([
        '【送信確認】',
        '---',
        '件名：RUNEインフォメーションです。',
        '',
        '本文：',
        bodyText,
        '---',
        '「送信」または「スキップ」',
      ].join('\n'));

      let confirmReply;
      try {
        confirmReply = await waitForLineReply();
      } catch (e) {
        console.log(`[TIMEOUT] uid=${contact.uid}: 送信確認 5分タイムアウト → スキップ`);
        continue;
      }
      console.log(`[LINE] 送信確認返信: ${confirmReply}`);

      if (confirmReply !== '送信') {
        console.log(`[SKIP] uid=${contact.uid} 送信確認でスキップ`);
        continue;
      }

      // ─── STEP8 ────────────────────────────────────────────────
      await submitContactReply(threadPage, bodyText, contact.uid, '返答');
    } finally {
      await threadPage.close().catch(() => {});
    }
  }
}

// ─── エントリポイント ─────────────────────────────────────────────

function stopContacts() {
  _shouldStop = true;
  console.log('=== contact-checker 停止要求 ===');
}

async function checkContacts() {
  _shouldStop = false;
  console.log('=== contact-checker 起動 ===');

  if (DRY_RUN) console.log('[DRY RUN] モード有効');
  clearState();

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    httpCredentials: {
      username: process.env.BASIC_AUTH_ID,
      password: process.env.BASIC_AUTH_PASS,
    },
  });

  try {
    const page = await context.newPage();
    await login(page);
    await processContacts(page);
    console.log('=== contact-checker 完了 ===');
  } catch (err) {
    console.error('[FATAL]', err.message, err.stack);
    await sendLine(`【システムエラー】contact-checker: ${err.message}`);
  } finally {
    clearState();
    await browser.close();
  }
}

if (require.main === module) {
  checkContacts();
}

module.exports = { checkContacts, stopContacts };

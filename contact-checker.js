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
 *   STEP4: 「スレッド確認」リンク先（mg_contact_edit.php）を開き、
 *          スレッド内の最新メッセージを取得
 *   STEP5: LINEに問い合わせ内容を通知し、返答内容の入力を依頼
 *   STEP6: LINEからの返答を受け取る（5分タイムアウト、「スキップ」で次へ）
 *   STEP7: テンプレートに差し込んだ送信内容をLINEで確認
 *   STEP8: 「送信」の場合、mg_contact_edit.php のフォームに入力して送信
 *
 * 【LINE返信待ちの仕組み】
 *   reply-checker.js と同じ /tmp/rune-reply-state.json を共有し、
 *   server.js の LINE webhook からの返信をポーリングで検知する（タイムアウト5分）
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');

const LOGIN_URL  = process.env.SYSTEM_URL || 'http://manager.x7j4l2p9m1.com/mg/mg_ope.php';
const BASE_URL   = LOGIN_URL.replace(/[^/]+$/, ''); // "http://manager.x7j4l2p9m1.com/mg/"
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DRY_RUN    = process.env.DRY_RUN === 'true';

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
// メインページのリンク a[href*="mg_contactMail.php"] をクリックする。
// target="_blank"で新しいページとして開かれる場合にも対応する

async function openContactMailPage(page) {
  console.log('[STEP1] mg_contactMail.php を開く');
  const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
  await page.click('a[href*="mg_contactMail.php"]');
  const popup = await popupPromise;

  let contactPage = page;
  if (popup) {
    console.log('[STEP1] 新しいページ(popup)で開かれました:', popup.url());
    await popup.waitForLoadState('networkidle').catch(() => {});
    contactPage = popup;
  } else {
    await page.waitForLoadState('networkidle').catch(() => {});
    console.log('[STEP1] 既存ページ内で遷移しました:', page.url());
  }
  return contactPage;
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

// ─── STEP4: スレッド確認（mg_contact_edit.php）を開き最新メッセージを取得 ──

async function openContactThread(page, threadHref) {
  const url = new URL(threadHref, BASE_URL).toString();
  console.log(`[STEP4] スレッド確認: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle' }).catch(async () => {
    await page.goto(url).catch(() => {});
  });
  return page;
}

// mg_contact_edit.php のスレッド内容から最新メッセージ本文を取得する。
// ※実際のページHTML構造が未確認のため、ある程度長いテキストを持つ要素
//   （子要素がテキスト/<br>のみ）のうち最後に出現するものを推定抽出する
//   ベストエフォート実装。取得できない/短すぎる場合は一覧の問い合わせ
//   文頭（previewText）にフォールバックする。要検証。
async function getLatestThreadMessage(page, previewText) {
  try {
    const text = await page.evaluate(() => {
      const isTextOnly = el => Array.from(el.childNodes).every(
        n => n.nodeType === Node.TEXT_NODE || n.nodeName === 'BR'
      );
      const blocks = Array.from(document.querySelectorAll('td, div, p'))
        .filter(el => isTextOnly(el))
        .map(el => (el.textContent || '').trim())
        .filter(t => t.length > 5);
      return blocks.length > 0 ? blocks[blocks.length - 1] : '';
    });
    if (text && text.length >= (previewText || '').length) {
      console.log(`[STEP4] スレッド本文取得: "${text.slice(0, 60)}..."`);
      return text;
    }
  } catch (e) {
    console.log('[STEP4] 問い合わせ内容の取得に失敗:', e.message);
  }
  console.log('[STEP4] 本文取得に失敗/不十分 → 一覧の問い合わせ文頭にフォールバック');
  return previewText;
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
    const threadPage = await openContactThread(contactPage, contact.threadHref);
    const content = await getLatestThreadMessage(threadPage, contact.preview);

    // ─── STEP5 ──────────────────────────────────────────────────
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

    // ─── STEP6 ──────────────────────────────────────────────────
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

    // ─── STEP7 ──────────────────────────────────────────────────
    const bodyText = buildContactReplyBody(answer);
    await sendLine([
      '【送信確認】',
      '---',
      'RUNEインフォメーションです。',
      '',
      '件名：RUNEインフォメーションです。',
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

    // ─── STEP8 ──────────────────────────────────────────────────
    if (DRY_RUN) {
      console.log(`[DRY RUN] 送信をスキップ: uid=${contact.uid}`);
      await sendLine(`【DRY RUN】uid=${contact.uid}への送信をスキップしました`);
      continue;
    }

    await threadPage.fill('input#messTempTitle', 'RUNEインフォメーションです。');
    await threadPage.fill('textarea#messTempBody', bodyText);
    await threadPage.click('input#gotoHeaven');
    await threadPage.waitForLoadState('networkidle').catch(() => {});
    console.log(`[SEND] uid=${contact.uid} 送信完了`);
    await sendLine(`【送信完了】uid=${contact.uid}へ返答を送信しました`);
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

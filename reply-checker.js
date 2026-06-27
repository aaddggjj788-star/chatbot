'use strict';

/**
 * reply-checker.js
 * サポート画面の未対応ユーザーへ返信文をCSVから取得し、
 * LINEで確認後にPlaywrightで送信するスクリプト
 *
 * 配置場所: /root/rune-bot/reply-checker.js
 * 実行: node reply-checker.js
 *
 * 【対象ユーザーの条件】
 *   「未」セル（#f00）があり、かつ鑑定士セルが #f0fff0 の行のみ処理する
 *   #87ceeb（担当外）/ #ffffe0（サポートキャラ）は除外
 *
 * 【LINE返信待ちの仕組み】
 *   server.js の LINE webhook と /tmp/rune-reply-state.json を共有し
 *   「送信」「スキップ」の受信をポーリングで検知する
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://manager.x7j4l2p9m1.com/mg/';
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CSV_DIR = process.env.REPLY_CSV_DIR || path.join(__dirname, 'reply-csv');

const DRY_RUN = process.env.DRY_RUN === 'true';

const STATE_FILE = '/tmp/rune-reply-state.json';
const POLL_INTERVAL_MS = 2000;
const REPLY_TIMEOUT_MS = 10 * 60 * 1000; // 10分

// ─── LINE 送信 ────────────────────────────────────────────────────

async function sendLine(message) {
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/broadcast',
      { messages: [{ type: 'text', text: message }] },
      {
        headers: {
          Authorization: `Bearer ${LINE_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    await new Promise(r => setTimeout(r, 1000));
  } catch (err) {
    console.error('LINE送信エラー:', err.message);
  }
}

// ─── LINE 返信待ち（ファイルポーリング）─────────────────────────────
// server.js が /tmp/rune-reply-state.json に返信内容を書き込むのを待つ

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
        reject(new Error('LINE返信タイムアウト（10分）'));
      }
    }, POLL_INTERVAL_MS);
  });
}

// ─── CSV 操作 ─────────────────────────────────────────────────────

function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const rows = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const cols = [];
    let inQuote = false;
    let cur = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        cols.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    cols.push(cur.replace(/\r$/, ''));
    rows.push(cols);
  }
  return rows;
}

// "12672yu9" → "12672_yu9.csv"
function charaIdToCsvName(charaId) {
  return charaId.replace(/^(\d+)(yu\d+)$/, '$1_$2') + '.csv';
}

function getReplyFromCSV(charaId, sinkoNum) {
  const csvPath = path.join(CSV_DIR, charaIdToCsvName(charaId));
  if (!fs.existsSync(csvPath)) throw new Error(`CSVなし: ${csvPath}`);

  const rows = parseCSV(csvPath);
  // スラッシュあり・なし両方に対応: <!--12672yu9/sinko3--> / <!--12672yu9/sinko/3-->
  const targets = [
    `<!--${charaId}/sinko${sinkoNum}-->`,
    `<!--${charaId}/sinko/${sinkoNum}-->`,
  ];
  const idx = rows.findIndex(r => targets.includes((r[0] || '').trim()));

  if (idx === -1) throw new Error(`コメント sinko${sinkoNum} がCSVに未発見`);
  if (idx + 1 >= rows.length) return null; // 末尾に到達

  return {
    replyText:   rows[idx + 1][1] || '',
    nextComment: rows[idx + 1][0] || '',
  };
}

// ─── Playwright: ログイン ─────────────────────────────────────────

async function login(page) {
  await page.goto(BASE_URL + 'mg_ope.php', { waitUntil: 'networkidle' });
  console.log('[LOGIN] タイトル:', await page.title());

  // セッション切れ対応（mail-checker.js と同じ方法）
  const sessionLink = page.locator('a[href*="s_system"]');
  if (await sessionLink.count() > 0) {
    console.log('[LOGIN] セッション切れ検知 → リンクをクリック');
    await sessionLink.first().click();
    await page.waitForLoadState('networkidle');
  }

  await page.fill('[name="id"]',    process.env.SYSTEM_LOGIN_ID);
  await page.fill('[name="pass"]',  process.env.SYSTEM_LOGIN_PASS);
  await page.click('[name="login"]');
  await page.waitForLoadState('networkidle');
  console.log('[LOGIN] 完了:', await page.title());
}

// ─── Playwright: サポート画面を新タブで開く ──────────────────────

async function openSupportPage(context, page) {
  const supportLoc = page.locator('a[href="mg_ope.php"].link_whi, a:text("サポート画面")');
  const [supportPage] = await Promise.all([
    context.waitForEvent('page'),
    supportLoc.first().click(),
  ]);
  await supportPage.waitForLoadState('networkidle');
  console.log('[SUPPORT] タブ切替完了:', await supportPage.title());
  return supportPage;
}

// ─── 対象ユーザー絞り込み（JS評価）─────────────────────────────────
//
// テーブル行を走査し、以下の両条件を満たす行のユーザー情報を返す:
//   1. いずれかのセルの style に "#f00" / "red" / "#ff0000" が含まれる（未対応）
//   2. いずれかのセルの style に "#f0fff0" が含まれる（担当鑑定士）
//
// 戻り値: [{ userName, onclick }] ※ページ内の出現順

async function getTargetUsers(page) {
  return await page.evaluate(() => {
    function hasBg(td, colors) {
      const s = (td.getAttribute('style') || '').toLowerCase().replace(/\s/g, '');
      return colors.some(c => s.includes(c.toLowerCase()));
    }

    const results = [];
    const rows = document.querySelectorAll('tr');

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length === 0) continue;

      const isUnread   = cells.some(td => hasBg(td, ['#f00', '#ff0000', 'red']));
      const isAssigned = cells.some(td => hasBg(td, ['#f0fff0']));
      if (!isUnread || !isAssigned) continue;

      const link = row.querySelector('a[onclick*="replay"]');
      if (!link) continue;

      results.push({
        userName: link.textContent.trim(),
        onclick:  link.getAttribute('onclick'),
      });
    }

    return results;
  });
}

// ─── Playwright: ユーザーを順番に処理 ────────────────────────────

async function processUsers(supportPage) {
  let userIndex = 0;

  while (true) {
    // 最新状態を取得するためリロード
    await supportPage.reload({ waitUntil: 'networkidle' });

    // 担当かつ未対応のユーザーを絞り込む
    const targets = await getTargetUsers(supportPage);
    console.log(`[SUPPORT] 対象ユーザー: ${targets.length}件 (処理済: ${userIndex}件)`);

    if (targets.length === 0 || userIndex >= targets.length) {
      console.log('[SUPPORT] 処理対象なし。終了');
      break;
    }

    const { userName, onclick } = targets[userIndex];
    console.log(`[USER] 処理中: ${userName}`);

    // onclick属性で該当リンクを特定してクリック（JS経由で確実に実行）
    await supportPage.evaluate((onclickVal) => {
      const link = Array.from(document.querySelectorAll('a[onclick*="replay"]'))
        .find(a => a.getAttribute('onclick') === onclickVal);
      if (link) link.click();
    }, onclick);

    // replay() はAjaxの可能性があるため networkidle + 追加待機
    await supportPage.waitForLoadState('networkidle').catch(() => {});
    await supportPage.waitForTimeout(1500);

    // 緑枠メッセージ一覧（innerHTML でHTMLコメントを含む）
    const greenEls = supportPage.locator(
      '[style*="background-color: #90EE90"],' +
      '[style*="background-color:#90EE90"],' +
      '[style*="background-color: rgb(144, 238, 144)"]'
    );
    const greenCount = await greenEls.count();

    if (greenCount === 0) {
      console.log(`[USER] ${userName}: 緑メッセージなし → スキップ`);
      userIndex++;
      continue;
    }

    // 最新（最後）の緑メッセージのHTML（HTMLコメントは innerText で取得不可のため innerHTML を使用）
    const lastGreenHtml = await greenEls.nth(greenCount - 1).innerHTML();
    console.log(`[MSG] HTML先頭150: ${lastGreenHtml.slice(0, 150)}`);

    // コメントアウト抽出: <!--12672yu9/sinko3--> / <!--12672yu9/sinko/3-->
    const commentMatch = lastGreenHtml.match(/<!--([a-zA-Z0-9]+)\/sinko\/?(\d+)-->/);
    if (!commentMatch) {
      await sendLine(
        `【要確認】${userName}のメッセージからコメントを抽出できませんでした\n` +
        `HTML先頭：${lastGreenHtml.slice(0, 100)}`
      );
      userIndex++;
      continue;
    }

    const charaId  = commentMatch[1]; // 例: "12672yu9"
    const sinkoNum = parseInt(commentMatch[2], 10); // 例: 3
    console.log(`[COMMENT] charaId=${charaId} sinko=${sinkoNum}`);

    // CSV から次の返信文を取得
    let replyData;
    try {
      replyData = getReplyFromCSV(charaId, sinkoNum);
    } catch (e) {
      await sendLine(`【エラー】CSV取得失敗: ${e.message}`);
      userIndex++;
      continue;
    }

    if (!replyData) {
      await sendLine(`【終了】${userName}の返信文章が終了しました`);
      userIndex++;
      continue;
    }

    // LINEに確認メッセージを送信
    const lineMsg = [
      '【返信確認】',
      `ユーザー：${userName}`,
      '返信文：',
      '---',
      replyData.replyText,
      replyData.nextComment,
      '---',
      '送信する場合は「送信」',
      'スキップする場合は「スキップ」と返信してください',
    ].join('\n');

    await sendLine(lineMsg);

    // LINE返信を待つ（server.js が state file に書き込むまでポーリング）
    let reply;
    try {
      reply = await waitForLineReply();
    } catch (e) {
      await sendLine(`【タイムアウト】${userName}の返信待ちがタイムアウトしました`);
      break;
    }

    console.log(`[LINE] 返信: ${reply}`);

    if (reply === '送信') {
      if (DRY_RUN) {
        console.log(`[DRY RUN] 送信をスキップ: ${userName}`);
        await sendLine(`【DRY RUN】${userName}への返信送信をスキップしました`);
      } else {
        await supportPage.fill('textarea#mess_body', replyData.replyText);
        await supportPage.click('#chara_mail_send');
        await supportPage.waitForLoadState('networkidle').catch(() => {});
        console.log(`[SEND] ${userName} 送信完了`);
        await sendLine(`【送信完了】${userName}への返信を送信しました`);
      }
    } else {
      console.log(`[SKIP] ${userName} スキップ`);
    }
    userIndex++;
  }
}

// ─── メイン ───────────────────────────────────────────────────────

async function main() {
  console.log('=== reply-checker 起動 ===');
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
    const supportPage = await openSupportPage(context, page);
    await processUsers(supportPage);
    console.log('=== reply-checker 正常終了 ===');
  } catch (err) {
    console.error('[FATAL]', err.message, err.stack);
    await sendLine(`【システムエラー】reply-checker: ${err.message}`);
  } finally {
    clearState();
    await browser.close();
  }
}

main();

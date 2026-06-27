'use strict';

/**
 * reply-checker.js
 * サポート画面の未対応ユーザーへ返信文をCSVから取得し、
 * LINEで確認後にPlaywrightで送信するスクリプト
 *
 * 配置場所: /root/rune-bot/reply-checker.js
 * 実行: node reply-checker.js  または  server.js から checkReplies() を呼ぶ
 *
 * 【対象ユーザー絞り込み（左パネル）】
 *   「未」セル (#f00) かつ 鑑定士セル (#f0fff0) が同一行にある
 *
 * 【詳細判定（メッセージ履歴）】
 *   最新の鑑定士メッセージ (#90EE90) より後に
 *   ユーザーメッセージ (#aaaaff / #ffaaaa) が存在し、
 *   かつそのメッセージ群に「既」が含まれない場合のみ対象
 *
 * 【LINE返信待ちの仕組み】
 *   server.js の LINE webhook と /tmp/rune-reply-state.json を共有し
 *   「送信」「スキップ」の受信をポーリングで検知する（タイムアウト5分）
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const LOGIN_URL   = process.env.SYSTEM_URL || 'http://manager.x7j4l2p9m1.com/mg/mg_ope.php';
const BASE_URL    = LOGIN_URL.replace(/[^/]+$/, ''); // "http://manager.x7j4l2p9m1.com/mg/"
// 親フレーム: mg_ope.php  左: iframe[name="ope_menu"]  右: iframe[name="ope_main"]
const LINE_TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CSV_DIR = process.env.REPLY_CSV_DIR || path.join(__dirname, 'reply-csv');
const DRY_RUN = process.env.DRY_RUN === 'true';

const STATE_FILE = '/tmp/rune-reply-state.json';
const POLL_INTERVAL_MS = 2000;
const REPLY_TIMEOUT_MS = 5 * 60 * 1000; // 5分

let _shouldStop = false;

// ─── LINE 送信 ────────────────────────────────────────────────────

async function sendLine(message) {
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/broadcast',
      { messages: [{ type: 'text', text: message }] },
      { headers: { Authorization: `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    await new Promise(r => setTimeout(r, 1000));
  } catch (err) {
    console.error('LINE送信エラー:', err.message);
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
  // スラッシュあり・なし両方に対応
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
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
  console.log('[LOGIN] タイトル:', await page.title());

  // セッション切れ対応（mail-checker.js と同じ方法）
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

// ─── Playwright: サポート左側一覧を開く ──────────────────────────

async function openSupportPage(page) {
  await page.goto(LOGIN_URL); // 親フレームページ（mg_ope.php）を開く
  await page.waitForLoadState('load');
  // iframeが読み込まれるまで待機
  await page.waitForSelector('iframe[name="ope_menu"]', { timeout: 10000 }).catch(() => {
    console.log('[WARN] ope_menuフレームが見つかりません');
  });
  console.log('[SUPPORT] 親ページ:', page.url());
  return page;
}

// ─── 対象ユーザー絞り込み（JS評価）─────────────────────────────────
//
// 左パネルのテーブル行を走査し、以下の両条件を満たす行のユーザー情報を返す:
//   1. いずれかのセルのstyleに "#f00" / "#ff0000" / "red" が含まれる（未対応）
//   2. いずれかのセルのstyleに "#f0fff0" が含まれる（担当鑑定士）
//
// 戻り値: [{ userName, onclick }] ※ページ内の出現順

async function getTargetUsers(page) {
  // ope_menuフレーム内で操作する
  const menuFrameLocator = page.frameLocator('iframe[name="ope_menu"]');

  // 赤背景セルが出現するまで最大10秒待機
  try {
    await menuFrameLocator.locator('td[style*="background-color: #f00"]').first().waitFor({ timeout: 10000 });
  } catch (_) {
    console.log('[DEBUG] waitForSelector タイムアウト: 赤背景セルが見つからなかった');
  }

  const menuFrame = page.frame({ name: 'ope_menu' });
  if (!menuFrame) {
    console.log('[DEBUG] ope_menuフレームが取得できません');
    return [];
  }

  const { results, debugInfo } = await menuFrame.evaluate(() => {
    function getBgStyle(el) {
      return el ? (el.getAttribute('style') || '(style属性なし)') : null;
    }

    // セレクターで直接件数を確認
    const unreadCells   = Array.from(document.querySelectorAll('td[style*="background-color: #f00"]'));
    const assignedCells = Array.from(document.querySelectorAll('td[style*="background-color: #f0fff0"]'));

    const rows = Array.from(document.querySelectorAll('tr'));
    const rowLogs = [];
    const results = [];

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length === 0) continue;

      const unreadCell   = cells.find(td => td.getAttribute('style') && td.getAttribute('style').includes('background-color: #f00'));
      const assignedCell = cells.find(td => td.getAttribute('style') && td.getAttribute('style').includes('background-color: #f0fff0'));

      if (unreadCell || assignedCell) {
        rowLogs.push({
          unreadBg:   getBgStyle(unreadCell),
          assignedBg: getBgStyle(assignedCell),
        });
      }

      if (!unreadCell || !assignedCell) continue;

      // formのaction属性からk_idとu_idを抽出
      // 例: <form action="mg_ope_noframe.php?k_id=12638&u_id=3866720">
      const form = row.querySelector('form[action*="k_id="]');
      if (!form) continue;

      const action = form.getAttribute('action') || '';
      const m = action.match(/k_id=(\d+)&(?:amp;)?u_id=(\d+)/);
      if (!m) continue;

      // ユーザー名はrow内のリンクテキストまたはフォーム内テキストから取得
      const link = row.querySelector('a');
      const userName = link ? link.textContent.trim() : form.textContent.trim();

      results.push({
        userName,
        kid: m[1],
        uid: m[2],
      });
    }

    return {
      results,
      debugInfo: {
        totalRows:        rows.length,
        unreadCellCount:  unreadCells.length,
        assignedCellCount: assignedCells.length,
        rowLogs,
      },
    };
  });

  // ─── デバッグログ（Node.js側で出力）────────────────────────────
  console.log(`[DEBUG] 全行数: ${debugInfo.totalRows}`);
  console.log(`[DEBUG] 未セル(#f00)件数: ${debugInfo.unreadCellCount}`);
  console.log(`[DEBUG] 鑑定士セル(#f0fff0)件数: ${debugInfo.assignedCellCount}`);
  for (const r of debugInfo.rowLogs) {
    if (r.unreadBg)   console.log(`[DEBUG]   未セルの背景色:    ${r.unreadBg}`);
    if (r.assignedBg) console.log(`[DEBUG]   鑑定士セルの背景色: ${r.assignedBg}`);
  }
  console.log(`[DEBUG] 条件に合った行数: ${results.length}`);

  return results;
}

// ─── メッセージ履歴の詳細判定（JS評価）──────────────────────────────
//
// 右パネルのメッセージを上から順に走査し、以下を判定:
//   - 最新の鑑定士メッセージ (#90EE90) を特定
//   - その後にユーザーメッセージ (#aaaaff / #ffaaaa) が存在するか
//   - そのユーザーメッセージ群に「既」が一つでもあるか
//
// 戻り値: { target: bool, reason: string, kanteishiHtml: string }

async function analyzeMessages(page) {
  const mainFrame = page.frame({ name: 'ope_main' });
  if (!mainFrame) {
    return { target: false, reason: 'ope_mainフレームが取得できません', kanteishiHtml: '' };
  }
  return await mainFrame.evaluate(() => {
    function normStyle(el) {
      return (el.getAttribute('style') || '').replace(/\s/g, '').toLowerCase();
    }

    // td / div からメッセージ要素をDOM順に収集
    const msgs = [];
    for (const el of document.querySelectorAll('td, div')) {
      const bg = normStyle(el);
      if (bg.includes('#90ee90') || bg.includes('rgb(144,238,144)')) {
        msgs.push({ type: 'kanteishi', html: el.innerHTML });
      } else if (bg.includes('#aaaaff') || bg.includes('#ffaaaa')) {
        const row = el.closest('tr') || el;
        msgs.push({ type: 'user', rowText: row.textContent || '' });
      }
    }

    // 最後の鑑定士メッセージのインデックスを探す
    let lastKIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].type === 'kanteishi') { lastKIdx = i; break; }
    }

    if (lastKIdx === -1) {
      return { target: false, reason: '鑑定士メッセージなし', kanteishiHtml: '' };
    }

    const afterUser = msgs.slice(lastKIdx + 1).filter(m => m.type === 'user');

    if (afterUser.length === 0) {
      return { target: false, reason: '鑑定士後にユーザーメッセージなし', kanteishiHtml: '' };
    }

    if (afterUser.some(m => m.rowText.includes('既'))) {
      return { target: false, reason: 'ユーザーメッセージに「既」あり', kanteishiHtml: '' };
    }

    return { target: true, reason: '', kanteishiHtml: msgs[lastKIdx].html };
  });
}

// ─── 返信処理メインループ ─────────────────────────────────────────

async function processUsers(page) {
  // page = mg_ope.php（親フレームページ）
  // ope_menuフレームから対象ユーザーを取得
  const targets = await getTargetUsers(page);
  console.log(`[LIST] 対象ユーザー: ${targets.length}件`);

  if (targets.length === 0) {
    await sendLine('未返信の対象ユーザーはいませんでした');
    return;
  }

  for (const { userName, kid, uid } of targets) {
    if (_shouldStop) {
      console.log('[STOP] 停止要求により中断');
      break;
    }
    console.log(`[USER] 確認中: ${userName} (k_id=${kid}, u_id=${uid})`);

    // ─── ope_menuフレーム内のformをsubmit → ope_mainに詳細が表示される ──
    const menuFrame = page.frame({ name: 'ope_menu' });
    if (!menuFrame) {
      console.log(`[WARN] ${userName}: ope_menuフレームが取得できません`);
      continue;
    }

    const formFound = await menuFrame.evaluate(({ kid, uid }) => {
      for (const row of document.querySelectorAll('tr')) {
        const form = row.querySelector('form[action*="k_id="]');
        if (!form) continue;
        const action = form.getAttribute('action') || '';
        if (action.includes(`k_id=${kid}`) && action.includes(`u_id=${uid}`)) {
          form.submit(); // target="ope_main" のまま送信（ope_mainフレームに表示される）
          return true;
        }
      }
      return false;
    }, { kid: String(kid), uid: String(uid) });

    if (!formFound) {
      console.log(`[WARN] ${userName}: フォームが見つかりません (k_id=${kid}, u_id=${uid})`);
      continue;
    }

    // ─── ope_mainフレームの読み込みを待つ ───────────────────────
    const mainFrame = page.frame({ name: 'ope_main' });
    if (mainFrame) {
      await mainFrame.waitForLoadState('load').catch(() => {});
    } else {
      await page.waitForTimeout(2000);
    }

    // ─── デバッグログ ──────────────────────────────────────────
    const mainFrameNow = page.frame({ name: 'ope_main' });
    if (mainFrameNow) {
      console.log(`[DEBUG] ope_main URL: ${mainFrameNow.url()}`);
    }
    const greenCount = await page.frameLocator('iframe[name="ope_main"]')
      .locator('tr[style*="background-color: #90EE90"], td[style*="background-color: #90EE90"]')
      .count().catch(() => 0);
    console.log(`[DEBUG] 緑セル件数: ${greenCount}`);

    // ─── メッセージ履歴の詳細判定 ───────────────────────────────
    const analysis = await analyzeMessages(page);
    if (!analysis.target) {
      console.log(`[SKIP] ${userName}: ${analysis.reason}`);
      continue;
    }

    // ─── コメントアウト抽出 ──────────────────────────────────────
    const commentMatch = analysis.kanteishiHtml.match(/<!--([a-zA-Z0-9]+)\/sinko\/?(\d+)-->/);
    if (!commentMatch) {
      console.log(`[WARN] ${userName}: コメントアウトなし`);
      await sendLine(`【要確認】${userName}：コメントアウトが見つかりません`);
      continue;
    }

    const charaId  = commentMatch[1];
    const sinkoNum = parseInt(commentMatch[2], 10);
    console.log(`[COMMENT] ${userName}: charaId=${charaId} sinko=${sinkoNum}`);

    // ─── CSVから次の返信文を取得 ─────────────────────────────────
    let replyData;
    try {
      replyData = getReplyFromCSV(charaId, sinkoNum);
    } catch (e) {
      await sendLine(`【エラー】CSV取得失敗 (${userName}): ${e.message}`);
      continue;
    }

    if (!replyData) {
      await sendLine(`【終了】${userName}の返信文章が終了しました`);
      continue;
    }

    // ─── LINEに確認メッセージを送信 ─────────────────────────────
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

    // ─── LINE返信を待つ（5分タイムアウト → スキップ）────────────
    let reply;
    try {
      reply = await waitForLineReply();
    } catch (e) {
      console.log(`[TIMEOUT] ${userName}: 5分タイムアウト → スキップ`);
      continue;
    }

    console.log(`[LINE] 返信: ${reply}`);

    // ─── 送信 or スキップ ────────────────────────────────────────
    if (reply === '送信') {
      const textToSend = replyData.replyText + '\n' + replyData.nextComment;
      if (DRY_RUN) {
        console.log(`[DRY RUN] 送信をスキップ: ${userName}`);
        await sendLine(`【DRY RUN】${userName}への返信送信をスキップしました`);
      } else {
        // ope_mainフレーム内のフォームに記入して送信
        const sendFrame = page.frame({ name: 'ope_main' });
        if (!sendFrame) {
          console.log(`[WARN] ${userName}: 送信時にope_mainフレームが取得できません`);
          continue;
        }
        await sendFrame.fill('textarea#mess_body', textToSend);
        await sendFrame.click('#chara_mail_send');
        await sendFrame.waitForLoadState('networkidle').catch(() => {});
        console.log(`[SEND] ${userName} 送信完了`);
        await sendLine(`【送信完了】${userName}への返信を送信しました`);
      }
    } else {
      console.log(`[SKIP] ${userName} スキップ`);
    }
  }
}

// ─── エントリポイント ─────────────────────────────────────────────

function stopReplies() {
  _shouldStop = true;
  console.log('=== reply-checker 停止要求 ===');
}

async function checkReplies() {
  _shouldStop = false;
  console.log('=== reply-checker 起動 ===');
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
    const supportPage = await openSupportPage(page);
    await processUsers(supportPage);
    console.log('=== reply-checker 完了 ===');
  } catch (err) {
    console.error('[FATAL]', err.message, err.stack);
    await sendLine(`【システムエラー】reply-checker: ${err.message}`);
  } finally {
    clearState();
    await browser.close();
  }
}

if (require.main === module) {
  checkReplies();
}

module.exports = { checkReplies, stopReplies };

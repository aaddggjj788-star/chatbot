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
const { parse: parseCSVSync } = require('csv-parse/sync');

const LOGIN_URL   = process.env.SYSTEM_URL || 'http://manager.x7j4l2p9m1.com/mg/mg_ope.php';
const BASE_URL    = LOGIN_URL.replace(/[^/]+$/, ''); // "http://manager.x7j4l2p9m1.com/mg/"
// 親フレーム: mg_ope.php  左: iframe[name="ope_menu"]  右: iframe[name="ope_main"]
const LINE_TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CSV_DIR = process.env.REPLY_CSV_DIR || path.join(__dirname, 'reply-csv');
const CHARA_CONFIG_DIR = path.join(__dirname, 'chara-config');
const DRY_RUN = process.env.DRY_RUN === 'true';

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

// ─── CSV 操作 ─────────────────────────────────────────────────────

function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return parseCSVSync(content, {
    relax_quotes:        true,   // フィールド内の " をリテラルとして扱う（HTML属性の""対応）
    relax_column_count:  true,   // 列数不一致でもエラーにしない
    skip_empty_lines:    false,  // B列内の空行（改行）を保持する
    quote:               '"',
    escape:              '"',
  });
}

// コメント文字列を分解する
// 単純形式: "12668mu1/sinko/2"    → { baseId:"12668", typeNum:"mu1", sub:null, type:"sinko", num:2 }
// 複合形式: "12668mu2/zenhan/sinko/1" → { baseId:"12668", typeNum:"mu2", sub:"zenhan", type:"sinko", num:1 }
function parseCommentStr(commentStr) {
  let m = commentStr.match(/^(\d+)((?:yu|mu)\d+)\/(sinko|his)\/?(\d+)$/);
  if (m) return { baseId: m[1], typeNum: m[2], sub: null, type: m[3], num: parseInt(m[4], 10) };
  m = commentStr.match(/^(\d+)((?:yu|mu)\d+)\/([a-z]+)\/(sinko|his)\/?(\d+)$/);
  if (m) return { baseId: m[1], typeNum: m[2], sub: m[3], type: m[4], num: parseInt(m[5], 10) };
  return null;
}

// コメント情報からJSONのphase設定を解決する
// 優先順: typeNum+sub ("mu2zenhan") → typeNum+type ("mu2his") → typeNum ("mu1")
function resolvePhaseCfg(parsed, config) {
  if (!parsed || !config?.phases) return null;
  const { typeNum, sub, type } = parsed;
  if (sub && config.phases[typeNum + sub]) return { key: typeNum + sub, cfg: config.phases[typeNum + sub] };
  if (config.phases[typeNum + type]) return { key: typeNum + type, cfg: config.phases[typeNum + type] };
  if (config.phases[typeNum])         return { key: typeNum,         cfg: config.phases[typeNum] };
  return null;
}

// charaIdをプレフィックスとしてCSVファイルを検索する
// fileIdが指定された場合はそのファイルを優先する
// sinkoを含むファイルを優先し、なければ数値が対象以下の最大ファイルにフォールバック
function resolveCsvPath(charaId, fileId) {
  let files;
  try { files = fs.readdirSync(CSV_DIR); } catch (_) { files = []; }

  // fileId指定がある場合は優先使用
  if (fileId) {
    const fp = path.join(CSV_DIR, fileId + '.csv');
    if (fs.existsSync(fp)) return { csvPath: fp, resolvedCharaId: fileId };
    console.log(`[CSV] fileId "${fileId}.csv" が見つかりません → プレフィックス検索に切り替え`);
  }

  // charaIdで始まるCSVを検索（sinkoを含むファイルを優先）
  function findByPrefix(prefix) {
    const candidates = files.filter(f => f.startsWith(prefix) && f.endsWith('.csv'));
    if (candidates.length === 0) return null;
    return candidates.find(f => f.includes('sinko')) || candidates[0];
  }

  const exactMatch = findByPrefix(charaId);
  if (exactMatch) {
    return { csvPath: path.join(CSV_DIR, exactMatch), resolvedCharaId: charaId };
  }

  // 数値サフィックスがある場合は小さい数値でフォールバック
  const m = charaId.match(/^(\d+)(yu|mu)(\d+)$/);
  if (m) {
    const [, baseId, type, numStr] = m;
    const targetNum = parseInt(numStr, 10);
    let bestNum = -1;
    let bestFile = null;
    for (const f of files) {
      if (!f.endsWith('.csv')) continue;
      const fm = f.match(new RegExp(`^${baseId}${type}(\\d+)`));
      if (!fm) continue;
      const n = parseInt(fm[1], 10);
      if (n <= targetNum && n > bestNum) { bestNum = n; bestFile = f; }
    }
    if (bestFile) {
      const resolvedCharaId = `${baseId}${type}${bestNum}`;
      console.log(`[CSV] ${charaId} のファイルが見つからないため ${bestFile} を使用 (charaId: ${resolvedCharaId})`);
      return { csvPath: path.join(CSV_DIR, bestFile), resolvedCharaId };
    }
  }

  return { csvPath: path.join(CSV_DIR, charaId + '.csv'), resolvedCharaId: charaId };
}

function getReplyFromCSV(charaId, sinkoNum) {
  const { csvPath, resolvedCharaId } = resolveCsvPath(charaId);
  if (!fs.existsSync(csvPath)) throw new Error(`CSVなし: ${csvPath}`);

  const rows = parseCSV(csvPath);
  console.log(`[CSV] 総行数: ${rows.length}`);

  // 1行目(rows[0])は件名データとして使用する
  const title = rows[0] ? (rows[0][0] || '') : '';
  console.log(`[CSV] 1行目A列(件名): "${title}"`);

  // sinko/N または his/N の行を特定する（sinko/2・sinko2 両形式に対応）
  const sinkoPattern = new RegExp(
    `<!--${resolvedCharaId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/(?:sinko|his)\\/?${sinkoNum}-->`
  );
  console.log(`[CSV] 検索パターン: ${sinkoPattern}`);
  const idx = rows.findIndex(r => sinkoPattern.test((r[0] || '').trim()));
  if (idx === -1) {
    // デバッグ: 先頭10行のA列を出力して何が入っているか確認
    const sample = rows.slice(0, 10).map((r, i) => `  row[${i}]: "${r[0] || ''}"`).join('\n');
    throw new Error(`コメント sinko/his ${sinkoNum} がCSVに未発見\nCSV先頭10行:\n${sample}`);
  }

  // ヒットした行の内容をログ出力
  const hitRow = rows[idx];
  console.log(`[CSV] ヒット行 idx=${idx} 全列: ${JSON.stringify(hitRow)}`);

  // 次の行(idx+1)を取得
  const nextRow = rows[idx + 1];
  if (!nextRow) return null; // 末尾に到達

  console.log(`[CSV] 次行 idx=${idx + 1} 全列: ${JSON.stringify(nextRow)}`);

  // A列(index 0): コメントアウト(例: <!--sinko3-->)  → 返信末尾に追記
  // B列(index 1): 返信文                              → これを返信本文として使用
  const nextComment = (nextRow[0] || '').trim();                    // A列
  const replyText   = (nextRow[1] || '').trim().replace(/\\n/g, '\n'); // B列: \n→改行

  console.log(`[CSV] A列(nextComment)="${nextComment}"`);
  console.log(`[CSV] B列(replyText)="${replyText.slice(0, 80)}"`);

  if (!replyText) {
    console.log('[CSV] 警告: B列(返信文)が空です。CSVのB列に内容があるか確認してください。');
  }

  return { title, replyText, nextComment };
}

// searchTarget指定でCSV内の特定コメント行を検索する
// useCurrentRow=true → ヒット行自身を返す / false → 次の行を返す（デフォルト）
function getReplyFromCSVByTarget(charaId, searchTarget, useCurrentRow, fileId) {
  const { csvPath } = resolveCsvPath(charaId, fileId);
  if (!fs.existsSync(csvPath)) throw new Error(`CSVなし: ${csvPath}`);
  const rows = parseCSV(csvPath);
  const title = rows[0] ? (rows[0][0] || '') : '';

  const escaped = searchTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<!--${escaped}-->`);
  const idx = rows.findIndex(r => pattern.test((r[0] || '').trim()));
  if (idx === -1) {
    const sample = rows.slice(0, 10).map((r, i) => `  row[${i}]: "${r[0] || ''}"`).join('\n');
    throw new Error(`searchTarget "${searchTarget}" がCSVに未発見\nCSV先頭10行:\n${sample}`);
  }

  const targetRow = useCurrentRow ? rows[idx] : rows[idx + 1];
  if (!targetRow) return null;

  const nextComment = (targetRow[0] || '').trim();
  const replyText   = (targetRow[1] || '').trim().replace(/\\n/g, '\n');
  console.log(`[CSV-TARGET] "${searchTarget}" useCurrentRow=${useCurrentRow} → idx=${useCurrentRow ? idx : idx + 1}`);
  return { title, replyText, nextComment };
}

// spanワードでCSVを検索して次の行のB列を返す
function getReplyFromCSVBySpan(charaId, spanWord, fileId) {
  const { csvPath } = resolveCsvPath(charaId, fileId);
  if (!fs.existsSync(csvPath)) throw new Error(`CSVなし: ${csvPath}`);
  const rows = parseCSV(csvPath);
  console.log(`[CSV] span検索: "${spanWord}" (総行数: ${rows.length})`);

  // A列にspanWordを含む行を検索
  const idx = rows.findIndex(r => (r[0] || '').includes(spanWord));
  if (idx === -1) throw new Error(`spanWord "${spanWord}" がCSVのA列に未発見`);

  console.log(`[CSV] span ヒット行 idx=${idx}: A列="${rows[idx][0]}"`);

  const nextRow = rows[idx + 1];
  if (!nextRow) return null;

  const nextComment = (nextRow[0] || '').trim();
  const replyText   = (nextRow[1] || '').trim().replace(/\\n/g, '\n');
  console.log(`[CSV] 次行 idx=${idx + 1}: A列="${nextComment}" B列="${replyText.slice(0, 50)}"`);

  return { replyText, nextComment };
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

      // onclick="javascript:replay('108894512609')" からstringIDを取得
      const onclickEl = row.querySelector('[onclick*="replay"]');
      if (!onclickEl) continue;
      const onclickVal = onclickEl.getAttribute('onclick') || '';
      const om = onclickVal.match(/replay\(['"]([^'"]+)['"]\)/);
      if (!om) continue;
      const stringID = om[1];

      // formのaction属性からk_idとu_idを抽出（ログ用）
      const form = row.querySelector('form[action*="k_id="]');
      const action = form ? (form.getAttribute('action') || '') : '';
      const m = action.match(/k_id=(\d+)&(?:amp;)?u_id=(\d+)/);

      // ユーザー名はrow内のリンクテキストまたはonclick要素のテキストから取得
      const link = row.querySelector('a');
      const userName = link ? link.textContent.trim() : onclickEl.textContent.trim();

      results.push({
        userName,
        kid:      m ? m[1] : '',
        uid:      m ? m[2] : '',
        stringID,
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

  const { result, debugRows, lastKIdx, afterUserCount } = await mainFrame.evaluate(() => {
    function normStyle(el) {
      return (el.getAttribute('style') || '').replace(/\s/g, '').toLowerCase();
    }

    // ── デバッグ: 全trの背景色と既/未 ──────────────────────────
    const debugRows = Array.from(document.querySelectorAll('tr')).map((tr, i) => {
      const style = tr.getAttribute('style') || '';
      const colorMatch = style.match(/#[0-9a-fA-F]{3,6}/);
      return {
        i,
        color: colorMatch ? colorMatch[0] : null,
        hasKi: tr.textContent.includes('既'),
      };
    });

    // ── メッセージ収集: DOM順（上=新しい → 下=古い）で走査 ──────
    // 上（tr番号小）= 新しいメッセージ、下（tr番号大）= 古いメッセージ。
    // 背景色が tr 自体に設定されている場合も拾うため tr を追加。
    const msgs = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('tr, td, div')) {
      if (seen.has(el)) continue;
      seen.add(el);
      const bg = normStyle(el);
      if (bg.includes('90ee90') || bg.includes('144,238,144')) {
        // コメントアウトは innerHTML だと &lt;!--...--&gt; にエンコードされるため
        // hidden input の value 属性から生テキストを取得して正規表現で抽出する
        const trEl = el.tagName === 'TR' ? el : (el.closest('tr') || el);
        const trHtml = trEl.innerHTML; // デバッグ用
        const bodyInput = trEl.querySelector('input[type="hidden"][id^="body_"]');
        const bodyText = bodyInput ? bodyInput.value : '';
        const comments = [];
        const cre = /<!--([^>]+)-->/g;
        let cm;
        while ((cm = cre.exec(bodyText)) !== null) { comments.push(cm[1]); }
        msgs.push({ type: 'kanteishi', html: el.innerHTML, trHtml, bodyText, comments });
      } else if (bg.includes('aaaaff') || bg.includes('ffaaaa')) {
        const row = el.closest('tr') || el;
        const timeTd = row.querySelector('td[style*="width:110px"]');
        const timeText = timeTd ? timeTd.textContent.trim() : '';
        msgs.push({ type: 'user', rowText: row.textContent || '', timeText });
      }
    }

    const emptyK = { kanteishiHtml: '', kanteishiTrHtml: '', kanteishiBodyText: '', kanteishiComments: [], allKanteishiComments: [], spanCount: 0, userMsgCount: 0, latestUserTime: '' };

    // 【判定2】最新メッセージチェック（DOM最上位 = 最新）
    if (msgs.length === 0) {
      return { result: { target: false, reason: 'メッセージなし', ...emptyK }, debugRows, lastKIdx: -1, afterUserCount: 0 };
    }
    if (msgs[0].type === 'kanteishi') {
      return { result: { target: false, reason: '最新メッセージが鑑定士（返信済み）', ...emptyK }, debugRows, lastKIdx: 0, afterUserCount: 0 };
    }

    // 最新の鑑定士メッセージを探す
    let firstKIdx = -1;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].type === 'kanteishi') { firstKIdx = i; break; }
    }

    if (firstKIdx === -1) {
      return { result: { target: false, reason: '鑑定士メッセージなし', ...emptyK }, debugRows, lastKIdx: firstKIdx, afterUserCount: 0 };
    }

    // 最新鑑定士より上（新しい）のユーザーメッセージ
    const beforeUser = msgs.slice(0, firstKIdx).filter(m => m.type === 'user');

    const km = msgs[firstKIdx];
    const bodyText = km.bodyText || '';

    // spanCount: 最新鑑定士bodyTextのspan個数を計算
    const spanRe = /<span class="fortune-word-insert">[^<]+<\/span>/g;
    let spanCount = 0;
    while (spanRe.exec(bodyText) !== null) spanCount++;

    const latestUserTime = beforeUser.length > 0 ? (beforeUser[0].timeText || '') : '';

    const allKanteishiComments = msgs.filter(m => m.type === 'kanteishi').flatMap(m => m.comments);
    const successK = {
      kanteishiHtml: km.html,
      kanteishiTrHtml: km.trHtml,
      kanteishiBodyText: bodyText,
      kanteishiComments: km.comments,
      allKanteishiComments,
      spanCount,
      userMsgCount: beforeUser.length,
      latestUserTime,
    };

    // 【判定3】既読チェック
    if (beforeUser.some(m => m.rowText.includes('既'))) {
      return { result: { target: false, reason: 'ユーザーメッセージに「既」あり', ...emptyK }, debugRows, lastKIdx: firstKIdx, afterUserCount: beforeUser.length };
    }

    return { result: { target: true, reason: '', ...successK }, debugRows, lastKIdx: firstKIdx, afterUserCount: beforeUser.length };
  });

  // ── Node.js側でデバッグログ出力 ────────────────────────────────
  for (const row of debugRows) {
    if (row.color) {
      console.log(`[DEBUG] tr[${row.i}]: 色=${row.color}, 既/未=${row.hasKi ? '既' : '未'}`);
    }
  }
  console.log(`[DEBUG] 最新鑑定士メッセージ index: ${lastKIdx}`);
  console.log(`[DEBUG] 鑑定士より新しいユーザーメッセージ: ${afterUserCount}件`);
  if (result.kanteishiTrHtml) {
    console.log(`[DEBUG] 鑑定士行HTML(先頭500文字): ${result.kanteishiTrHtml.slice(0, 500)}`);
  }
  console.log(`[DEBUG] 最新鑑定士コメント: ${JSON.stringify(result.kanteishiComments)}`);
  console.log(`[DEBUG] span個数: ${result.spanCount}, ユーザーメッセージ通数: ${result.userMsgCount}`);
  console.log(`[DEBUG] 最新ユーザー受信時刻: "${result.latestUserTime}"`);

  return result;
}

// ─── キャラ設定読み込み ───────────────────────────────────────────

function loadCharaConfig(charaId) {
  const configPath = path.join(CHARA_CONFIG_DIR, `${charaId}.json`);
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

// start===end → 常時稼働。start>end → 深夜またぎ。start<end → 同日内停止。
function isInStopTime(charaId) {
  const config = loadCharaConfig(charaId);
  let startMin, endMin;
  if (config && config.globalStopTime) {
    const parse = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    startMin = parse(config.globalStopTime.start);
    endMin   = parse(config.globalStopTime.end);
  } else {
    startMin = 23 * 60; // デフォルト 23:00
    endMin   =  9 * 60; // デフォルト 09:00
  }
  if (startMin === endMin) return false; // 常時稼働
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  return startMin > endMin
    ? cur >= startMin || cur < endMin   // 深夜またぎ（例: 23:00〜9:00）
    : cur >= startMin && cur < endMin;  // 同日内（例: 9:00〜17:00）
}

// ─── 受信時刻パーサー ─────────────────────────────────────────────
// "06月28日 03時27分" → Date オブジェクト（現在年を補完）

function parseMessageTime(timeStr) {
  const m = timeStr.match(/(\d+)月(\d+)日\s*(\d+)時(\d+)分/);
  if (!m) return null;
  const now = new Date();
  const d = new Date(now.getFullYear(), parseInt(m[1], 10) - 1, parseInt(m[2], 10), parseInt(m[3], 10), parseInt(m[4], 10), 0, 0);
  // 年をまたいだ場合の補正（例：12月のメッセージを1月に処理する）
  if (d.getTime() > now.getTime()) d.setFullYear(d.getFullYear() - 1);
  return d;
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

  for (const { userName, kid, uid, stringID } of targets) {
    if (_shouldStop) {
      console.log('[STOP] 停止要求により中断');
      break;
    }

    // ─── キャラ別停止時間チェック ──────────────────────────────────
    if (isInStopTime(kid)) {
      console.log(`[SKIP] ${userName}: 停止時間帯のためスキップ (k_id=${kid})`);
      continue;
    }

    console.log(`[USER] 確認中: ${userName} (k_id=${kid}, u_id=${uid}, stringID=${stringID})`);

    // ─── フレーム取得 ────────────────────────────────────────────
    const menuFrame = page.frame({ name: 'ope_menu' });
    if (!menuFrame) {
      console.log(`[WARN] ${userName}: ope_menuフレームが取得できません`);
      continue;
    }
    const mainFrame = page.frame({ name: 'ope_main' });
    if (!mainFrame) {
      console.log(`[WARN] ${userName}: ope_mainフレームが取得できません`);
      continue;
    }

    // ─── submit前に#bodyKakuninを空にする（2件目以降の誤検知防止）──
    await mainFrame.evaluate(() => {
      const el = document.querySelector('#bodyKakunin');
      if (el) el.innerHTML = '';
    });

    // ─── ope_menuフレームでformをsubmit → Ajaxでope_mainを更新 ──
    try {
      await menuFrame.evaluate((stringID) => {
        const form = document.getElementById(stringID);
        if (!form) throw new Error(`id="${stringID}" のformが見つかりません`);
        form.submit();
      }, stringID);
    } catch (e) {
      console.log(`[WARN] ${userName}: form.submit()に失敗: ${e.message}`);
      continue;
    }

    // ─── 500ms固定待機後、Ajax完了を待つ ────────────────────────
    await new Promise(r => setTimeout(r, 500));
    try {
      await mainFrame.waitForFunction(() => {
        const el = document.querySelector('#bodyKakunin');
        const trCount = document.querySelectorAll('tr').length;
        return el !== null && el.innerHTML.length > 0 && trCount >= 20;
      }, { timeout: 15000 });
    } catch (_) {
      console.log(`[WARN] ${userName}: #bodyKakunin のタイムアウト`);
    }

    // ─── デバッグログ ──────────────────────────────────────────
    console.log(`[DEBUG] ope_main URL: ${mainFrame.url()}`);
    // [style*="#90EE90"] で空白の有無に関わらず全て取得
    const greenCount = await page.frameLocator('iframe[name="ope_main"]')
      .locator('tr[style*="#90EE90"], td[style*="#90EE90"]')
      .count().catch(() => 0);
    console.log(`[DEBUG] 緑セル件数: ${greenCount}`);

    // ─── メッセージ履歴の詳細判定 ───────────────────────────────
    const analysis = await analyzeMessages(page);
    if (!analysis.target) {
      console.log(`[SKIP] ${userName}: ${analysis.reason}`);
      continue;
    }

    // ─── 判定4: span個数とユーザーメッセージ通数の照合 ──────────
    const { spanCount, userMsgCount } = analysis;
    console.log(`[SPAN-CHECK] ${userName}: ユーザーメッセージ=${userMsgCount}通, span個数=${spanCount}`);
    if (spanCount > 0 && userMsgCount !== spanCount) {
      console.log(`[SKIP] ${userName}: ユーザーメッセージ通数(${userMsgCount})とspan個数(${spanCount})が不一致`);
      continue;
    }

    // ─── 判定5: コメントアウト判定（最新鑑定士メッセージのみ）──
    const allComments = analysis.kanteishiComments || [];
    console.log(`[COMMENT-LIST] ${userName}: ${JSON.stringify(allComments)}`);

    // /mtm・/do を含むコメントがある → スキップ
    if (allComments.some(c => /\/mtm\b|\/do\b/.test(c))) {
      console.log(`[SKIP] ${userName}: /mtm・/do コメントあり`);
      continue;
    }

    const hasHo = allComments.some(c => /\/ho\b/.test(c));

    // /sinko も /his も /ho も含まれない → スキップ
    if (!hasHo && !allComments.some(c => c.includes('/sinko') || c.includes('/his'))) {
      console.log(`[SKIP] ${userName}: /sinko・/his・/hoコメントなし`);
      continue;
    }

    let charaId = null;
    let replyData;

    if (hasHo) {
      // /ho の場合: 全メッセージ履歴から最新sinko/hisコメントを検索してsinko+1を送信
      const historyComments = analysis.allKanteishiComments || [];
      const historySinkoComments = historyComments.filter(c => /(?:sinko|his)\/?(\d+)/.test(c));

      for (const c of historySinkoComments) {
        const m = c.match(/^(\d+(?:yu|mu)\d+)/);
        if (m) { charaId = m[1]; break; }
      }

      if (!charaId) {
        console.log(`[SKIP] ${userName}: /hoあり・履歴にsinko/hisコメントなし`);
        continue;
      }

      const histSinkoNums = historySinkoComments
        .map(c => { const m = c.match(/(?:sinko|his)\/?(\d+)/); return m ? parseInt(m[1], 10) : null; })
        .filter(n => n !== null);
      const maxSinko = Math.max(...histSinkoNums);

      console.log(`[COMMENT] ${userName}: /hoモード charaId=${charaId} 履歴最大sinko=${maxSinko}`);
      try {
        replyData = getReplyFromCSV(charaId, maxSinko);
      } catch (e) {
        console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
        continue;
      }
    } else {
      // 通常の sinko/his 処理
      const sinkoComments = allComments.filter(c => /(?:sinko|his)\/?(\d+)/.test(c));

      const sinkoNums = sinkoComments
        .map(c => { const m = c.match(/(?:sinko|his)\/?(\d+)/); return m ? parseInt(m[1], 10) : null; })
        .filter(n => n !== null);

      // charaId を抽出（複合コメント形式にも対応）
      for (const c of sinkoComments) {
        const m = c.match(/^(\d+(?:yu|mu)\d+)/);
        if (m) { charaId = m[1]; break; }
      }

      // sinkoが1件のみ かつ 番号が1 → スキップ
      if (sinkoNums.length === 1 && sinkoNums[0] === 1) {
        console.log(`[SKIP] ${userName}: sinko1のみ（初回メッセージ）`);
        continue;
      }

      console.log(`[COMMENT] ${userName}: charaId=${charaId} sinkoNums=${JSON.stringify(sinkoNums)}`);

      // ─── JSON設定の読み込み ──────────────────────────────────────
      const maxSinkoNum = Math.max(...sinkoNums);
      const latestComment = sinkoComments.find(c => {
        const m = c.match(/(?:sinko|his)\/?(\d+)/);
        return m && parseInt(m[1], 10) === maxSinkoNum;
      });
      const parsed     = latestComment ? parseCommentStr(latestComment) : null;
      const baseCharaId = parsed?.baseId ?? (charaId?.match(/^(\d+)/)?.[1] ?? null);
      const charaCfg   = baseCharaId ? loadCharaConfig(baseCharaId) : null;
      const phaseResult = (parsed && charaCfg) ? resolvePhaseCfg(parsed, charaCfg) : null;
      const phaseCfg   = phaseResult?.cfg ?? null;
      const fileId     = phaseCfg?.fileId ?? null;
      const actionKey  = parsed ? `${parsed.type}${parsed.num}` : null;
      const actionCfg  = (phaseCfg && actionKey) ? (phaseCfg[actionKey] ?? null) : null;

      console.log(`[JSON] baseCharaId=${baseCharaId} phase=${phaseResult?.key} action=${actionKey} config=${JSON.stringify(actionCfg)}`);

      // ─── JSON設定に基づく処理分岐 ────────────────────────────────
      if (actionCfg) {
        if (actionCfg.specialProcess) {
          console.log(`[JSON] specialProcess: ${JSON.stringify(actionCfg.specialProcess)}`);
        }

        if (actionCfg.branch) {
          // A/B分岐: LINEで選択してもらう
          const branchMsg = [
            `【分岐選択】${userName}`,
            `A: ${actionCfg.branch.positive}`,
            `B: ${actionCfg.branch.negative}`,
            `「A」または「B」と返信してください`,
          ].join('\n');
          await sendLine(branchMsg);
          let branchChoice;
          try { branchChoice = await waitForLineReply(); } catch (e) { continue; }
          const branchTarget = (branchChoice.trim().toUpperCase() === 'A')
            ? actionCfg.branch.positive
            : actionCfg.branch.negative;
          console.log(`[JSON] 分岐: ${branchChoice} → ${branchTarget}`);
          try {
            replyData = getReplyFromCSVByTarget(charaId, branchTarget, false, fileId);
          } catch (e) {
            console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
            continue;
          }
        } else if (actionCfg.timeBasedSearch) {
          // 時間帯に応じてsearchTargetを選択
          const now = new Date();
          const curMin = now.getHours() * 60 + now.getMinutes();
          let selected = null;
          for (const [cKey, cVal] of Object.entries(actionCfg.timeBasedSearch)) {
            const bm = cKey.match(/^before(\d{3,4})$/);
            const am = cKey.match(/^after(\d{3,4})$/);
            if (bm) {
              const t = bm[1].padStart(4, '0');
              const tMin = parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(2), 10);
              if (curMin < tMin) { selected = cVal; break; }
            } else if (am) {
              const t = am[1].padStart(4, '0');
              const tMin = parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(2), 10);
              if (curMin >= tMin) { selected = cVal; break; }
            }
          }
          if (!selected) {
            console.log(`[JSON] timeBasedSearch: 一致する時間帯なし → スキップ`);
            continue;
          }
          const useCurrentRow = selected.useCurrentRow === true;
          console.log(`[JSON] timeBasedSearch → "${selected.searchTarget}" useCurrentRow=${useCurrentRow}`);
          try {
            replyData = getReplyFromCSVByTarget(charaId, selected.searchTarget, useCurrentRow, fileId);
          } catch (e) {
            console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
            continue;
          }
        } else if (actionCfg.searchTarget) {
          const useCurrentRow = actionCfg.useCurrentRow === true;
          console.log(`[JSON] searchTarget="${actionCfg.searchTarget}" useCurrentRow=${useCurrentRow}`);
          try {
            replyData = getReplyFromCSVByTarget(charaId, actionCfg.searchTarget, useCurrentRow, fileId);
          } catch (e) {
            console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
            continue;
          }
        }
        // specialProcessのみなど、searchTarget系設定がない場合はデフォルト動作へ
      }

      // ─── デフォルト動作（JSON設定なし、またはsearchTarget系設定なし）──
      if (!replyData) {
        const allSameNum = sinkoNums.every(n => n === sinkoNums[0]);

        if (allSameNum) {
          // span検索モード: 最新鑑定士メッセージのbodyTextからspanワードを抽出
          const bodyText = analysis.kanteishiBodyText || '';
          const spanMatch = bodyText.match(/<span class="fortune-word-insert">([^<]+)<\/span>/);
          if (!spanMatch) {
            console.log(`[WARN] ${userName}: spanワードが見つかりません (bodyText長=${bodyText.length})`);
            continue;
          }
          const spanWord = spanMatch[1];
          console.log(`[COMMENT] ${userName}: span検索モード spanWord="${spanWord}"`);
          try {
            replyData = getReplyFromCSVBySpan(charaId, spanWord, fileId);
          } catch (e) {
            console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
            continue;
          }
        } else {
          console.log(`[COMMENT] ${userName}: sinko+1検索モード maxSinko=${maxSinkoNum}`);
          try {
            replyData = getReplyFromCSV(charaId, maxSinkoNum);
          } catch (e) {
            console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
            continue;
          }
        }
      }
    }

    if (!replyData) {
      await sendLine(`【終了】${userName}の返信文章が終了しました`);
      continue;
    }

    // ─── LINEに確認メッセージを送信 ─────────────────────────────
    // \n（リテラル）が残っている場合に備えて実際の改行に変換してから表示
    const displayReplyText = replyData.replyText.replace(/\\n/g, '\n');
    const lineMsg = [
      '【返信確認】',
      `ユーザー：${userName}`,
      '返信文：',
      '---',
      displayReplyText,
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
      // 返信文（sinko/N+1 のB列）+ 次のコメントアウト（sinko/N+1 のA列）を末尾に追記
      const textToSend = replyData.replyText + '\n' + replyData.nextComment;
      console.log(`[SEND-TEXT] 送信内容: "${textToSend.slice(0, 80)}..."`);
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

        // ─── タイマー判定 ────────────────────────────────────────
        const receivedAt = parseMessageTime(analysis.latestUserTime || '');
        const nowTs = new Date();
        const TIMER_MIN = 15;
        let useTimer = false;
        let timerTs = null;
        if (receivedAt) {
          const elapsedMin = (nowTs.getTime() - receivedAt.getTime()) / 60000;
          if (elapsedMin < TIMER_MIN) {
            useTimer = true;
            timerTs = new Date(receivedAt.getTime() + TIMER_MIN * 60000);
            console.log(`[TIMER] ${userName}: 受信から${elapsedMin.toFixed(1)}分 → タイマー設定 (送信予定: ${timerTs.toLocaleTimeString('ja-JP')})`);
          } else {
            console.log(`[TIMER] ${userName}: 受信から${elapsedMin.toFixed(1)}分経過 → 即時送信`);
          }
        } else {
          console.log(`[TIMER] ${userName}: 受信時刻が取得できません → 即時送信`);
        }

        // 本文：返信文 + 改行 + 次のコメントアウト
        await sendFrame.fill('textarea#mess_body', textToSend);

        if (useTimer) {
          // タイマーモードに切り替え
          await sendFrame.click('input[name="timerSet"][value=""]');
          // receivehun(Unixタイムスタンプ秒) をブラウザ側で実行
          const tsSeconds = Math.floor(timerTs.getTime() / 1000);
          await sendFrame.evaluate((ts) => {
            if (typeof receivehun === 'function') receivehun(ts);
          }, tsSeconds);
          console.log(`[TIMER] ${userName}: タイムスタンプ=${tsSeconds} receivehun()実行済み`);
        }

        await sendFrame.click('#chara_mail_send');
        await sendFrame.waitForLoadState('networkidle').catch(() => {});
        console.log(`[SEND] ${userName} 送信完了`);
        await sendLine(`【送信完了】${uid}へ${kid}からの返信を送信しました`);
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

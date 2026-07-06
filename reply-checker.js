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
//           "12668mu1/his/2"     → { ..., type:"his", num:2 }
//           "12668mu1/hisu/2"    → { ..., type:"his", num:2 }（his*はhisに正規化）
// 複合形式: "12668mu2/zenhan/sinko/1" → { baseId:"12668", typeNum:"mu2", sub:"zenhan", type:"sinko", num:1 }
function parseCommentStr(commentStr) {
  let m = commentStr.match(/^(\d+)((?:yu|mu)\d+)\/(sinko|his\w*)\/?(\d+)$/);
  if (m) {
    const type = m[3].startsWith('his') ? 'his' : m[3];
    return { baseId: m[1], typeNum: m[2], sub: null, type, num: parseInt(m[4], 10) };
  }
  m = commentStr.match(/^(\d+)((?:yu|mu)\d+)\/([a-z]+)\/(sinko|his\w*)\/?(\d+)$/);
  if (m) {
    const type = m[4].startsWith('his') ? 'his' : m[4];
    return { baseId: m[1], typeNum: m[2], sub: m[3], type, num: parseInt(m[5], 10) };
  }
  return null;
}

// コメント一覧の中から sinko/his 番号が最大のコメントを返す（判定4のspanMatchRange解決用）
function getLatestSinkoComment(comments) {
  let best = null, bestNum = -1;
  for (const c of comments || []) {
    const m = c.match(/(?:sinko|his\w*)\/?(\d+)/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n > bestNum) { bestNum = n; best = c; }
  }
  return best;
}

// 最新コメントがspanMatchRange設定の範囲（同一baseId/typeNum/type かつ num範囲内）に該当するか判定する
function matchesSpanRange(comment, rangeList) {
  if (!comment || !rangeList || rangeList.length === 0) return null;
  const parsed = parseCommentStr(comment);
  if (!parsed) return null;
  for (const r of rangeList) {
    const fromP = parseCommentStr(r.from);
    const toP = parseCommentStr(r.to);
    if (!fromP || !toP) continue;
    if (parsed.baseId === fromP.baseId && parsed.typeNum === fromP.typeNum && parsed.type === fromP.type &&
        parsed.num >= fromP.num && parsed.num <= toP.num) {
      return r;
    }
  }
  return null;
}

// 三段形式の特殊コメント解析（sinkoHo/noresHo/stop1/hisuMtm等のrequiredMessages対象）
// 例: "12668yu1/sinko/ho"  → { actionKey:"sinkoHo",  ... }
// 例: "12668yu1/stop/1"    → { actionKey:"stop1",    ... }
// 例: "12668mu1/hisu/mtm"  → { actionKey:"hisuMtm",  ... }
// ※ part3が英字の場合は先頭大文字にしてキャメルケースで結合（数字はそのまま）
// ※ sinko/his + 数値（通常のsinko/his番号コメント）は除外
function parseSubActionComment(commentStr) {
  const m = commentStr.match(/^(\d+)((?:yu|mu)\d+\w*)\/([a-zA-Z]+)\/(\w+)$/);
  if (!m) return null;
  const sub = m[3];
  const part3 = m[4];
  if (/^(?:sinko|his)/.test(sub) && /^\d+$/.test(part3)) return null; // 通常 sinko/his 番号は除外
  // part3が英字なら先頭を大文字化してキャメルケースに結合（例: mtm→Mtm, ho→Ho）
  const part3Key = /^\d+$/.test(part3) ? part3 : (part3.charAt(0).toUpperCase() + part3.slice(1));
  const actionKey = sub + part3Key;
  return { baseId: m[1], typeNum: m[2], sub, part3, actionKey, charaId: m[1] + m[2], comment: commentStr };
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

// hoコメントのtypeNumからphase設定を解決する
// 完全一致 → typeNumを接頭辞とするphase検索 (例: "yu3" → "yu3sinko")
// 複数マッチ時はhoTypeキーを持つphaseを優先
function resolveHoPhase(charaCfg, typeNum, hoType) {
  const phases = charaCfg?.phases || {};
  if (phases[typeNum]) return { key: typeNum, cfg: phases[typeNum] };

  const prefixMatches = Object.entries(phases).filter(([k]) => k.startsWith(typeNum));
  if (prefixMatches.length === 0) {
    // 通常のphase解決で見つからない場合、minPhaseNumberが設定された
    // phaseを探し、typeNumの数値部分がminPhaseNumber以上であれば
    // そのphaseの設定を流用する（例: yu29 → 数値29 → minPhaseNumber=10のyu10を使用）
    const numMatch = typeNum.match(/(\d+)/);
    if (numMatch) {
      const num = parseInt(numMatch[1], 10);
      const minPhaseEntry = Object.entries(phases).find(
        ([, p]) => typeof p.minPhaseNumber === 'number' && num >= p.minPhaseNumber
      );
      if (minPhaseEntry) return { key: minPhaseEntry[0], cfg: minPhaseEntry[1] };
    }
    return null;
  }
  if (prefixMatches.length === 1) return { key: prefixMatches[0][0], cfg: prefixMatches[0][1] };

  // 複数マッチ → hoTypeキー（完全 or 数値サフィックス除去）を持つphaseを優先
  const baseKey = hoType ? hoType.replace(/\d+$/, '') : null;
  const withKey = prefixMatches.find(([, p]) =>
    (hoType && p[hoType] !== undefined) || (baseKey && baseKey !== hoType && p[baseKey] !== undefined)
  );
  if (withKey) return { key: withKey[0], cfg: withKey[1] };
  return { key: prefixMatches[0][0], cfg: prefixMatches[0][1] };
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

// 1列CSV形式用: A列 "返信文...<!--comment-->" から本文とコメントを分離する
function splitAColumn(aContent) {
  const s = (aContent || '').trim();
  const commentStart = s.lastIndexOf('<!--');
  if (commentStart >= 0) {
    return {
      replyText: s.slice(0, commentStart).trim().replace(/\\n/g, '\n').trim(),
      nextComment: s.slice(commentStart),
    };
  }
  return {
    replyText: s.replace(/\\n/g, '\n').trim(),
    nextComment: '',
  };
}

function getReplyFromCSV(charaId, sinkoNum) {
  const { csvPath, resolvedCharaId } = resolveCsvPath(charaId);
  if (!fs.existsSync(csvPath)) throw new Error(`CSVなし: ${csvPath}`);

  const rows = parseCSV(csvPath);
  console.log(`[CSV] 総行数: ${rows.length}`);

  // 1行目(rows[0])は件名データとして使用する
  const title = rows[0] ? (rows[0][0] || '') : '';
  console.log(`[CSV] 1行目A列(件名): "${title}"`);

  // sinko/N または his/N の行を特定する（sinko/2・sinko2・sinko/3/A 等に対応）
  const sinkoPattern = new RegExp(
    `<!--${resolvedCharaId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/(?:sinko|his)\\/?${sinkoNum}(?:\\/[A-Za-z0-9]+)?-->`
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

  // A列 = "返信文...<!--コメント-->" 形式: 本文とコメントマーカーを分離
  const { replyText, nextComment } = splitAColumn(nextRow[0]);

  console.log(`[CSV] nextComment="${nextComment}"`);
  console.log(`[CSV] replyText="${replyText.slice(0, 80)}"`);

  if (!replyText) {
    console.log('[CSV] 警告: 返信文が空です。CSVのA列を確認してください。');
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

  // 特殊文字をエスケープしつつ、数字の直前スラッシュは省略形も許容（his/2 ↔ his2）
  const escaped = searchTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flexEscaped = escaped.replace(/\/(\d)/g, '\\/?$1');
  const pattern = new RegExp(`<!--${flexEscaped}-->`);

  console.log(`[CSV-TARGET] 検索: "${searchTarget}" pattern=${pattern}`);

  const idx = rows.findIndex(r => pattern.test((r[0] || '').trim()));
  if (idx === -1) {
    const sample = rows.slice(0, 10).map((r, i) => `  row[${i}]: "${(r[0] || '').trim().slice(0, 60)}"`).join('\n');
    throw new Error(`searchTarget "${searchTarget}" がCSVに未発見\nCSV先頭10行:\n${sample}`);
  }

  console.log(`[CSV-TARGET] マッチ: row[${idx}] A="${(rows[idx][0] || '').trim().slice(0, 60)}"`);

  const resultIdx = useCurrentRow ? idx : idx + 1;
  const targetRow = rows[resultIdx];
  if (!targetRow) return null;

  const { replyText, nextComment } = splitAColumn(targetRow[0]);
  console.log(`[CSV-TARGET] 取得: useCurrentRow=${useCurrentRow} → row[${resultIdx}] nextComment="${nextComment}" replyText="${replyText.slice(0, 40)}"`);
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

  const { replyText, nextComment } = splitAColumn(nextRow[0]);
  console.log(`[CSV] 次行 idx=${idx + 1}: nextComment="${nextComment}" replyText="${replyText.slice(0, 50)}"`);

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

// HTML実体参照をデコードする（デバッグ表示用）
function decodeHtml(text) {
  return String(text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
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

  const { result, lastKIdx, afterUserCount } = await mainFrame.evaluate(() => {
    function normStyle(el) {
      return (el.getAttribute('style') || '').replace(/\s/g, '').toLowerCase();
    }

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
        const trText = trEl.textContent || ''; // 既/未判定用
        const bodyInput = trEl.querySelector('input[type="hidden"][id^="body_"]');
        const bodyText = bodyInput ? bodyInput.value : '';
        const comments = [];
        const cre = /<!--([^>]+)-->/g;
        let cm;
        while ((cm = cre.exec(bodyText)) !== null) { comments.push(cm[1]); }
        msgs.push({ type: 'kanteishi', html: el.innerHTML, trHtml, trText, bodyText, comments });
      } else if (bg.includes('aaaaff') || bg.includes('ffaaaa')) {
        const row = el.closest('tr') || el;
        const timeTd = row.querySelector('td[style*="width:110px"]');
        const timeText = timeTd ? timeTd.textContent.trim() : '';
        const fullRowText = row.textContent || '';
        msgs.push({ type: 'user', rowText: fullRowText, timeText });
      }
    }

    const emptyK = { kanteishiHtml: '', kanteishiTrHtml: '', kanteishiBodyText: '', kanteishiComments: [], allKanteishiComments: [], spanCount: 0, userMsgCount: 0, latestUserTime: '', latestUserTexts: [] };

    // 【判定2】最新メッセージチェック（DOM最上位 = 最新）
    if (msgs.length === 0) {
      return { result: { target: false, reason: 'メッセージなし', ...emptyK }, lastKIdx: -1, afterUserCount: 0 };
    }
    if (msgs[0].type === 'kanteishi') {
      return { result: { target: false, reason: '最新メッセージが鑑定士（返信済み）', ...emptyK }, lastKIdx: 0, afterUserCount: 0 };
    }

    // 最新の鑑定士メッセージを探す
    let firstKIdx = -1;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].type === 'kanteishi') { firstKIdx = i; break; }
    }

    if (firstKIdx === -1) {
      return { result: { target: false, reason: '鑑定士メッセージなし', ...emptyK }, lastKIdx: firstKIdx, afterUserCount: 0 };
    }

    // 【判定1.5】最新鑑定士メッセージの既/未チェック（「未」ならスキップ）
    if (!(msgs[firstKIdx].trText || '').includes('既')) {
      return { result: { target: false, reason: '最新鑑定士メッセージが未読', ...emptyK }, lastKIdx: firstKIdx, afterUserCount: 0 };
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
    const latestUserTexts = beforeUser.map(m => m.rowText || '');
    const successK = {
      kanteishiHtml: km.html,
      kanteishiTrHtml: km.trHtml,
      kanteishiBodyText: bodyText,
      kanteishiComments: km.comments,
      allKanteishiComments,
      spanCount,
      userMsgCount: beforeUser.length,
      latestUserTime,
      latestUserTexts,
    };

    // 【判定3】既読チェック
    if (beforeUser.some(m => m.rowText.includes('既'))) {
      return { result: { target: false, reason: 'ユーザーメッセージに「既」あり', ...emptyK }, lastKIdx: firstKIdx, afterUserCount: beforeUser.length };
    }

    return { result: { target: true, reason: '', ...successK }, lastKIdx: firstKIdx, afterUserCount: beforeUser.length };
  });

  // div.bodyNaibuのテキストを取得する。tr全体のtextContent（rowText）には
  // 「未」「07月06日 09時37分」「ユーザー」等のメタ情報が混入するため、
  // 50文字判定・相談判定・相談内容の引用にはこちらを使用する
  const bodyNaibuTexts = await getBodyNaibuTexts(mainFrame);

  // 【追加判定】50文字以上メッセージチェック（bodyNaibuTextsで判定する）
  const normalize = (t) => t.replace(/[\t\n\r]/g, '').replace(/\s+/g, ' ').trim();
  const hasLongMessage = bodyNaibuTexts.some(t => normalize(t).length >= 50);
  if (hasLongMessage) {
    bodyNaibuTexts.forEach((t, i) => {
      const decoded = decodeHtml(t);
      console.log(`[DEBUG] bodyNaibu[${i}] 文字数=${decoded.length} テキスト="${decoded.slice(0, 80)}"`);
    });
    return { target: false, reason: 'ユーザーメッセージに50文字以上のものあり' };
  }

  // ── Node.js側でデバッグログ出力 ────────────────────────────────
  console.log(`[DEBUG] 最新鑑定士メッセージ index: ${lastKIdx}`);
  console.log(`[DEBUG] 鑑定士より新しいユーザーメッセージ: ${afterUserCount}件`);
  if (result.kanteishiTrHtml) {
    console.log(`[DEBUG] 鑑定士行HTML(先頭100文字): ${result.kanteishiTrHtml.slice(0, 100)}`);
  }
  console.log(`[DEBUG] 最新鑑定士コメント: ${JSON.stringify(result.kanteishiComments)}`);
  console.log(`[DEBUG] span個数: ${result.spanCount}, ユーザーメッセージ通数: ${result.userMsgCount}`);
  console.log(`[DEBUG] 最新ユーザー受信時刻: "${result.latestUserTime}"`);

  return { ...result, bodyNaibuTexts };
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

// phase設定の時間帯制限チェック（stopAfter/activeFrom/activeUntilのいずれかが制限中なら true）
function isPhaseBlocked(phaseCfg) {
  if (!phaseCfg) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const parseMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  if (phaseCfg.stopAfter && cur >= parseMin(phaseCfg.stopAfter)) return true;
  if (phaseCfg.activeFrom && cur < parseMin(phaseCfg.activeFrom)) return true;
  if (phaseCfg.activeUntil && cur >= parseMin(phaseCfg.activeUntil)) return true;
  return false;
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

// ─── A/B分岐自動判定 ─────────────────────────────────────────────
// 最新のユーザーメッセージ1件のみを対象にキーワード判定する
// 肯定キーワードあり → A（最優先）
// 肯定なし・否定あり → B
// どちらもなし → B（デフォルト）
function detectBranchChoice(userTexts) {
  const text = (Array.isArray(userTexts) ? userTexts[0] : userTexts) || '';
  // 肯定キーワード（長い→短い順: 複合表現を単語より先にマッチさせる）
  const positiveKeywords = [
    'あったと思います', 'チャンスはあった', 'ばりばりあった',
    'あったと思う', 'あると思う', 'あったと感じ',
    'あったかも', 'ありました', '思えます',
  ];
  // 否定キーワード（長い→短い順）
  const negativeKeywords = [
    '心当たりがない', 'なかったです', 'ないと思う', 'わからない',
    '特にない', 'ないかも', 'ないです', '思えない', '感じない',
    'なかった', '無かった', '無い',
  ];
  for (const kw of positiveKeywords) {
    if (text.includes(kw)) {
      console.log(`[BRANCH] 肯定キーワード "${kw}" 検出 → A`);
      return 'A';
    }
  }
  for (const kw of negativeKeywords) {
    if (text.includes(kw)) {
      console.log(`[BRANCH] 否定キーワード "${kw}" 検出 → B`);
      return 'B';
    }
  }
  console.log('[BRANCH] キーワードなし → B（デフォルト）');
  return 'B';
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

// ─── specialProcess ヘルパー ──────────────────────────────────────

// テキスト全体からニックネームを抽出する（名前の位置は不定のため全体検索）
// 戻り値: { nickname: string|null, needsConfirmation: false }
//
// 優先順位:
//   0. 1行目が名前パターン（最優先）
//   1. パターン4「○○さん/ちゃん」（前置き除去後）
//   2. パターン3「名前は○○」/ パターン2「私は○○」/ パターン1「○○と言います/です」
//   3. パターン5「日付/血液型行と隣接する単独行の日本語2-6文字」
//
// 候補確定後 → resolveNickname で男女判定:
//   スペース区切りフルネーム → 男性漢字あり:苗字 / 女性漢字あり:名前 / 不明:苗字
//   漢字+かなスペースなし（桐林みよこ） → かな部分を名前（女性）として登録
//   漢字のみスペースなし（佐々木小次郎） → 苗字2-3文字+名前2-3文字に分割して男女判定
function extractNickname(userTexts) {
  const rawText = Array.isArray(userTexts) ? userTexts.join('\n') : (userTexts || '');
  if (!rawText.trim()) return { nickname: null, needsConfirmation: false };
  // 各行先頭の「| 」「|」を除去してから処理（CRMのメッセージ引用マーカー対応）
  const text = rawText.split('\n').map(l => l.replace(/^\|\s*/, '').trim()).join('\n');

  const MALE_KANJI   = '郎太介助男雄史人輔吾平之彦紀信義和一二三樹也典明';
  const FEMALE_KANJI = '子美香奈菜花恵代江葉衣里紗咲愛優心結莉麻希絵';

  // 候補文字列をニックネームに解決（フルネームを苗字/名前に分割して男女判定）
  function resolveNickname(candidate) {
    candidate = (candidate || '').trim();
    if (!candidate) return null;

    // スペース区切りフルネーム（例: 田中 花子、佐々木 小次郎）
    const spaceMatch = candidate.match(/^([^\s　]{1,6})[\s　]+([^\s　]{1,6})$/);
    if (spaceMatch) {
      const [, surname, givenName] = spaceMatch;
      const hasMale   = [...givenName].some(c => MALE_KANJI.includes(c));
      const hasFemale = [...givenName].some(c => FEMALE_KANJI.includes(c));
      if (hasMale)   return surname;
      if (hasFemale) return givenName;
      return surname;
    }

    // 漢字+ひらがな/カタカナのスペースなしフルネーム（例: 桐林みよこ）
    // ひらがな/カタカナの名前は女性名として名前（後半）を登録
    const kanjiKanaMatch = candidate.match(/^([一-龥々]{1,3})([ぁ-んァ-ヶー]{2,4})$/);
    if (kanjiKanaMatch) return kanjiKanaMatch[2];

    // 漢字のみスペースなしフルネーム（例: 佐々木小次郎、田中太郎）
    // 苗字2-3文字 + 名前2-3文字 で分割して男女判定
    const kanjiOnlyMatch = candidate.match(/^([一-龥々]{2,3})([一-龥々]{2,3})$/);
    if (kanjiOnlyMatch) {
      const [, surname, givenName] = kanjiOnlyMatch;
      const hasMale   = [...givenName].some(c => MALE_KANJI.includes(c));
      const hasFemale = [...givenName].some(c => FEMALE_KANJI.includes(c));
      if (hasMale)   return surname;
      if (hasFemale) return givenName;
      return surname;
    }

    return candidate; // スペースなし単独名/ニックネーム → そのまま
  }

  // 名前行かどうかを判定する
  // 条件: 漢字(々含む)/ひらがな/カタカナのみ2-6文字 かつ 除外ワードを含まない
  const NAME_LINE_RE = /^[一-龥々ぁ-んァ-ヶー]{2,6}$/;
  const EXCLUDE_WORDS = ['ない', 'なかった', 'かった', 'あった', '思う', 'です', 'ます'];
  function isNameLine(line) {
    if (!NAME_LINE_RE.test(line)) return false;
    return !EXCLUDE_WORDS.some(w => line.includes(w));
  }

  const rawLines = text.split('\n').map(l => l.trim());

  // 【最優先】1行目（空行スキップ）が名前パターンなら即採用
  const firstLine = rawLines.find(l => l.length > 0) || '';
  if (isNameLine(firstLine)) {
    const nick = resolveNickname(firstLine);
    if (nick) return { nickname: nick, needsConfirmation: false };
  }

  // 【優先度1】パターン4: 「○○さん」「○○ちゃん」
  // 「私の事は/みんなからは」等の前置き表現を除去してからマッチ
  const textForSan = text.replace(/私の?[事こと]は/g, '').replace(/みんなからは/g, '');
  // 「さん」は除去して前半のみ登録（もっさん→もっ）
  const sanM = textForSan.match(/([一-龥々ぁ-んァ-ヶーa-zA-Z0-9]{1,10})さん/);
  if (sanM) return { nickname: sanM[1].trim(), needsConfirmation: false };
  // 「ちゃん」はニックネームの一部としてそのまま登録（さっちゃん→さっちゃん）
  const chanM = textForSan.match(/([一-龥々ぁ-んァ-ヶーa-zA-Z0-9]{1,10}ちゃん)/);
  if (chanM) return { nickname: chanM[1].trim(), needsConfirmation: false };

  // 【優先度2】パターン3: 「名前は○○」（明示パターン）
  const nameWaM = text.match(/名前は([一-龥々ぁ-んァ-ヶー]{2,6})/);
  if (nameWaM) {
    const nick = resolveNickname(nameWaM[1]);
    if (nick) return { nickname: nick, needsConfirmation: false };
  }

  // 【優先度2】パターン2: 「私は○○」（自己紹介パターン）
  const watashiM = text.match(/私は([一-龥々ぁ-んァ-ヶー]{2,6})/);
  if (watashiM) {
    const nick = resolveNickname(watashiM[1]);
    if (nick) return { nickname: nick, needsConfirmation: false };
  }

  // 【優先度2】パターン1: 「○○と言います/と申します/です」（名乗りパターン）
  const selfM = text.match(/([一-龥々ぁ-んァ-ヶー]{2,6})(?:と言います|と申します|といいます|です)/);
  if (selfM) {
    const nick = resolveNickname(selfM[1]);
    if (nick) return { nickname: nick, needsConfirmation: false };
  }

  // 【優先度3】パターン5: 日付/血液型行と隣接する名前候補行
  const isDateLine    = s => /\d{1,4}[\/\-]\d{1,2}[\/\-]?\d{1,2}/.test(s);
  const isBloodLine   = s => /^(?:AB|[ABO])型?$/.test(s);
  const isContextLine = s => isDateLine(s) || isBloodLine(s);

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!isNameLine(line)) continue;
    const prev = i > 0 ? rawLines[i - 1] : '';
    const next = i < rawLines.length - 1 ? rawLines[i + 1] : '';
    if (isContextLine(prev) || isContextLine(next)) {
      const nick = resolveNickname(line);
      if (nick) return { nickname: nick, needsConfirmation: false };
    }
  }

  return { nickname: null, needsConfirmation: false };
}

// saveMemo1: ope_mainフレーム内の非公開メモ1に先頭追記して保存（最新1件のみ）
async function saveMemo1(frame, userText, dryRun) {
  const newContent = userText.trim();
  if (!newContent) {
    console.log('[SPECIAL] saveMemo1: ユーザーメッセージなし → スキップ');
    return;
  }
  let existingMemo = '';
  try {
    existingMemo = await frame.inputValue('textarea[name="user_memo1"]');
  } catch (_) {}

  const combined = existingMemo.trim()
    ? newContent + '\n\n' + existingMemo.trim()
    : newContent;

  if (dryRun) {
    console.log(`[DRY RUN] saveMemo1 先頭追記:\n${combined.slice(0, 200)}`);
    return;
  }

  await frame.fill('textarea[name="user_memo1"]', combined);
  await frame.click('input[name="memo_henko"]#user_memo_submit');
  await frame.waitForLoadState('networkidle').catch(() => {});
  console.log('[SPECIAL] saveMemo1: 保存完了');
}

// saveNickname: ope_mainフレーム内のあだ名欄にニックネームを保存（最新1件のみ）
async function saveNickname(frame, userText, dryRun) {
  const { nickname } = extractNickname([userText]);

  if (!nickname) {
    console.log('[SPECIAL] saveNickname: ニックネームを抽出できず → スキップ');
    return;
  }
  console.log(`[SPECIAL] saveNickname: 抽出ニックネーム="${nickname}"`);

  if (dryRun) {
    console.log(`[DRY RUN] saveNickname: "${nickname}" 入力をスキップ`);
    return;
  }

  await frame.fill('input[name="nickname"]', nickname);
  await frame.click('input[name="memo_henko"]#appointment_memo');
  await frame.waitForLoadState('networkidle').catch(() => {});
  console.log(`[SPECIAL] saveNickname: "${nickname}" 保存完了`);
}

// specialProcessリストを実行する（ope_mainフレーム内で直接操作）
async function executeSpecialProcess(processes, page, uid, analysis, dryRun, bodyNaibuTexts) {
  if (!processes || processes.length === 0) return;

  // div.bodyNaibu から取得したテキストを優先。なければ analysis のフォールバック
  const allUserTexts = (bodyNaibuTexts && bodyNaibuTexts.length > 0)
    ? bodyNaibuTexts
    : (analysis.latestUserTexts || []);
  if (allUserTexts.length === 0) {
    console.log('[SPECIAL] ユーザーメッセージなし → specialProcess スキップ');
    return;
  }

  // saveMemo1/saveNickname は最新（一番上）の1件のみを対象にする
  const latestUserText = allUserTexts[0];
  console.log(`[SPECIAL] 最新ユーザーテキスト(1件): "${latestUserText.slice(0, 80)}"`);

  const mainFrame = page.frame({ name: 'ope_main' });
  if (!mainFrame) {
    console.error('[SPECIAL ERROR] ope_mainフレームが見つかりません');
    return;
  }

  console.log(`[SPECIAL] ope_mainフレームで処理: ${JSON.stringify(processes)}`);
  try {
    for (const proc of processes) {
      if (proc === 'saveMemo1') {
        await saveMemo1(mainFrame, latestUserText, dryRun);
      } else if (proc === 'saveNickname') {
        await saveNickname(mainFrame, latestUserText, dryRun);
      } else {
        console.log(`[SPECIAL] 未実装のprocess: "${proc}"`);
      }
    }
  } catch (e) {
    console.error(`[SPECIAL ERROR] ${e.message}`);
  }
}

// ope_mainフレームの div.bodyNaibu からユーザーメッセージ本文のみ取得する
// 全 div.bodyNaibu から鑑定士行（90ee90 背景）に属するものを除外し、
// さらに最新の鑑定士メッセージより上（新しい）のユーザー分のみに限定する
// （analyzeMessages()のfirstKIdx判定と同じ基準で最新鑑定士要素を特定する。
//  indexそのものはevaluate()の呼び出しをまたいで受け渡せないため、
//  ここで同じ基準を使って独自に境界を再判定する）
// DOM順（上=最新）で返す。<br> は改行として扱い、他のHTMLタグは除去する
async function getBodyNaibuTexts(frame) {
  try {
    const { texts, totalCount, userCount, filteredCount } = await frame.evaluate(() => {
      function normStyle(el) {
        return (el.getAttribute('style') || '').replace(/\s/g, '').toLowerCase();
      }
      function isKanteishiBg(el) {
        const bg = normStyle(el);
        return bg.includes('90ee90') || bg.includes('144,238,144');
      }
      function isKanteishiAncestor(el) {
        let node = el.parentElement;
        while (node) {
          if (isKanteishiBg(node)) return true;
          node = node.parentElement;
        }
        return false;
      }

      // 最新の鑑定士メッセージ要素（DOM順で最初に見つかる鑑定士背景の
      // tr/td/div）を特定する
      let latestKanteishiEl = null;
      for (const el of document.querySelectorAll('tr, td, div')) {
        if (isKanteishiBg(el)) { latestKanteishiEl = el; break; }
      }

      const all = Array.from(document.querySelectorAll('div.bodyNaibu'));
      const userOnly = all.filter(el => !isKanteishiAncestor(el));

      // 最新鑑定士メッセージより上（新しい）のユーザーメッセージのみに限定する
      const filtered = userOnly.filter(el => {
        if (!latestKanteishiEl) return true;
        const pos = el.compareDocumentPosition(latestKanteishiEl);
        return !!(pos & Node.DOCUMENT_POSITION_FOLLOWING);
      });

      const texts = filtered
        .map(el => el.innerHTML.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim())
        .filter(t => t.length > 0);
      return { texts, totalCount: all.length, userCount: userOnly.length, filteredCount: filtered.length };
    });
    console.log(`[DEBUG] getBodyNaibuTexts: 全bodyNaibu=${totalCount}件 / ユーザー行=${userCount}件 / 最新鑑定士より上=${filteredCount}件 / テキスト=${texts.length}件`);
    if (texts.length > 0) console.log('[DEBUG] getBodyNaibuTexts 先頭:', texts[0].slice(0, 120));
    return texts;
  } catch (e) {
    console.error('[ERROR] getBodyNaibuTexts:', e.message);
    return [];
  }
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
    if (process.env.DISABLE_STOP_TIME !== 'true' && isInStopTime(kid)) {
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

    // ─── 受信時刻チェック（20分以内はスキップ）────────────────────
    const receivedAt = parseMessageTime(analysis.latestUserTime || '');
    if (receivedAt) {
      const elapsedMin = (new Date().getTime() - receivedAt.getTime()) / 60000;
      if (elapsedMin < 20) {
        console.log(`[TIMER] ${userName}: 受信から${elapsedMin.toFixed(1)}分 → 20分未満のためスキップ`);
        continue;
      }
      console.log(`[TIMER] ${userName}: 受信から${elapsedMin.toFixed(1)}分経過 → 処理続行`);
    } else {
      console.log(`[TIMER] ${userName}: 受信時刻が取得できません → 処理続行`);
    }

    // div.bodyNaibu から本文テキストを取得（analyzeMessages()内で取得済みのものを再利用）
    const bodyNaibuTexts = analysis.bodyNaibuTexts || [];
    console.log(`[BODY] ${userName}: bodyNaibu ${bodyNaibuTexts.length}件取得`);

    // コメントを事前取得（判定4より前にrequiredMessages有無を確認するため）
    const allComments = analysis.kanteishiComments || [];
    console.log(`[COMMENT-LIST] ${userName}: ${JSON.stringify(allComments)}`);

    // 三段形式の特殊コメント検出（sinkoHo/noresHo/stop1等）
    const subActionComments = allComments.map(parseSubActionComment).filter(Boolean);
    const hasSubAction = subActionComments.length > 0;

    // ─── 判定4: span個数とユーザーメッセージ通数の照合 ──────────
    // subActionコメントあり（requiredMessages独自判定を使う）→ span照合スキップ
    // spanMatchExclude: 最新コメントアウトが除外リストに含まれる場合はスキップ
    // spanMatchRange: 対象範囲内の場合、span個数 >= ユーザーメッセージ通数 - minOffset であればOK
    const _charaCfgForSpan = loadCharaConfig(kid);
    const _spanExcludeList = _charaCfgForSpan?.spanMatchExclude ?? [];
    const spanMatchExcluded = _spanExcludeList.length > 0 && allComments.some(c => _spanExcludeList.includes(c));
    if (spanMatchExcluded) {
      console.log(`[SPAN-CHECK] ${userName}: spanMatchExclude に一致 → span個数チェックをスキップ`);
    }
    const _spanRangeList = _charaCfgForSpan?.spanMatchRange ?? [];
    const _latestSinkoForSpan = getLatestSinkoComment(allComments);
    const _spanRangeMatch = matchesSpanRange(_latestSinkoForSpan, _spanRangeList);

    const { spanCount, userMsgCount } = analysis;
    console.log(`[SPAN-CHECK] ${userName}: ユーザーメッセージ=${userMsgCount}通, span個数=${spanCount}`);
    if (!spanMatchExcluded && !hasSubAction && spanCount > 0) {
      if (_spanRangeMatch) {
        const minOffset = _spanRangeMatch.minOffset ?? 0;
        console.log(`[SPAN-CHECK] ${userName}: spanMatchRange一致 (${_spanRangeMatch.from}〜${_spanRangeMatch.to}, minOffset=${minOffset})`);
        if (spanCount < userMsgCount - minOffset) {
          console.log(`[SKIP] ${userName}: span個数(${spanCount}) < ユーザーメッセージ通数(${userMsgCount})-${minOffset}`);
          continue;
        }
      } else if (userMsgCount !== spanCount) {
        console.log(`[SKIP] ${userName}: ユーザーメッセージ通数(${userMsgCount})とspan個数(${spanCount})が不一致`);
        continue;
      }
    }
    if (hasSubAction && spanCount > 0 && userMsgCount !== spanCount) {
      console.log(`[SPAN-CHECK] ${userName}: subActionあり → span照合スキップ`);
    }

    // ─── 念言チェック ────────────────────────────────────────────
    {
      const kanteishiBody = analysis.kanteishiBodyText || '';
      const nengenWords = [];
      const nengenRe = /<span class="fortune-word-insert">([^<]+)<\/span>/g;
      let nengenM;
      while ((nengenM = nengenRe.exec(kanteishiBody)) !== null) {
        nengenWords.push(nengenM[1]);
      }
      if (nengenWords.length > 0) {
        const userTexts = bodyNaibuTexts.length > 0 ? bodyNaibuTexts : (analysis.latestUserTexts || []);
        const allUserText = userTexts.join('');
        const nengenFound = nengenWords.some(w => allUserText.includes(w));
        console.log(`[NENGEN] ${userName}: 念言=${JSON.stringify(nengenWords)} 含有=${nengenFound}`);
        if (!nengenFound) {
          console.log(`[SKIP] ${userName}: 念言がユーザーメッセージに未発見`);
          continue;
        }
        // ─── 相談内容の判定 ──────────────────────────────────────
        // bodyNaibuTextsの各テキストごとに判定し、該当したテキストを
        // 相談内容としてLINE通知で引用できるよう保持する
        const CONSULT_KEYWORDS = ['？', '?', 'かな', 'でしょうか', 'ですか', '教えて'];
        const consultationTexts = userTexts.filter(t => t.length >= 20 || CONSULT_KEYWORDS.some(kw => t.includes(kw)));
        analysis.hasConsultation = consultationTexts.length > 0;
        analysis.consultationTexts = consultationTexts;
        console.log(`[CONSULT] ${userName}: 該当${consultationTexts.length}件 hasConsultation=${analysis.hasConsultation}`);
      } else {
        analysis.hasConsultation = false;
        analysis.consultationTexts = [];
      }
    }

    // ─── 判定5: コメントアウト判定（最新鑑定士メッセージのみ）──

    // /mtm を含むコメントがある → スキップ（/his との共存は除外）
    // /do は別途 CSV 検索で処理するためスキップしない
    const hasMtm = allComments.some(c => /\/mtm\b/.test(c));
    if (hasMtm) {
      const hasBothMtmAndHis = allComments.some(c => /\/mtm\b/.test(c) && /\/his/.test(c));
      if (!hasBothMtmAndHis) {
        console.log(`[SKIP] ${userName}: /mtm コメントあり（/his なし）`);
        continue;
      }
      console.log(`[INFO] ${userName}: /mtm と /his が共存 → スキップしない`);
    }

    // ho系コメントの検出（数値サフィックス・接頭辞付きも含む: ho1, sinkoHo, noresHo, hiruHo1等）
    const hoComments = allComments.filter(c => /\/[a-zA-Z]*[Hh]o\d*$/.test(c));
    const hasHo = hoComments.length > 0;

    // /sinko も /his も /ho も subAction も含まれない → スキップ
    if (!hasSubAction && !hasHo && !allComments.some(c => c.includes('/sinko') || c.includes('/his'))) {
      console.log(`[SKIP] ${userName}: /sinko・/his・/ho・subActionコメントなし`);
      continue;
    }

    let charaId = null;
    let replyData;
    let latestComment = null;

    if (hasSubAction) {
      // ─── subAction処理（requiredMessages判定 + searchTarget）──────
      let skipUser = false;
      for (const parsed of subActionComments) {
        const charaCfg = loadCharaConfig(parsed.baseId);
        const phaseResult = (charaCfg && parsed.typeNum)
          ? resolveHoPhase(charaCfg, parsed.typeNum, parsed.actionKey)
          : null;
        let phaseCfg  = phaseResult?.cfg ?? null;
        if (isPhaseBlocked(phaseCfg)) {
          console.log(`[TIME] ${userName}: subAction phase "${phaseResult?.key}" 時間帯制限 → スキップ`);
          phaseCfg = null;
        }
        let actionCfg = phaseCfg?.[parsed.actionKey] ?? null;
        if (!actionCfg && parsed.actionKey !== 'ho' && phaseCfg) {
          actionCfg = phaseCfg['ho'] ?? null;
          if (actionCfg) {
            console.log(`[JSON] actionKey="${parsed.actionKey}" → "ho"にフォールバック`);
          }
        }

        console.log(`[COMMENT] ${userName}: subAction comment="${parsed.comment}" actionKey="${parsed.actionKey}" phase=${phaseResult?.key} actionCfg=${JSON.stringify(actionCfg)}`);

        if (!actionCfg) {
          if (parsed.sub === 'do') {
            // /do コメント: JSON設定なしでも CSV を直接検索して次行を送信
            charaId = parsed.charaId;
            latestComment = parsed.comment;
            const doFileId = phaseCfg?.fileId ?? null;
            console.log(`[DO] ${userName}: /do 直接検索 comment="${parsed.comment}" charaId="${charaId}" fileId="${doFileId}"`);
            try {
              replyData = getReplyFromCSVByTarget(charaId, parsed.comment, false, doFileId);
            } catch (e) {
              console.error(`[ERROR] /do CSV取得失敗 (${userName}): ${e.message}`);
              skipUser = true;
            }
            break;
          }
          console.log(`[SKIP] ${userName}: subAction actionCfgなし (${parsed.actionKey})`);
          skipUser = true;
          break;
        }

        charaId      = parsed.charaId;
        latestComment = parsed.comment;

        // requiredMessages判定
        if (actionCfg.requiredMessages) {
          const combinedText = (bodyNaibuTexts.length > 0 ? bodyNaibuTexts : (analysis.latestUserTexts || [])).join('');
          let matchCount = 0;
          for (const alternatives of actionCfg.requiredMessages) {
            if (alternatives.some(kw => combinedText.includes(kw))) matchCount++;
          }
          const required = actionCfg.requiredCount || 0;
          console.log(`[JSON] requiredMessages: ${matchCount}/${required} マッチ (${parsed.actionKey})`);
          if (matchCount < required) {
            console.log(`[SKIP] ${userName}: requiredMessages 未達 (${matchCount}/${required})`);
            skipUser = true;
            break;
          }
        }

        const fileId = phaseCfg.fileId ?? null;
        console.log(`[JSON] subAction charaId="${parsed.charaId}" fileId="${fileId}" actionKey="${parsed.actionKey}"`);

        // specialProcessがある場合はbranch/searchTargetの前に実行
        if (actionCfg.specialProcess) {
          console.log(`[JSON] subAction specialProcess: ${JSON.stringify(actionCfg.specialProcess)}`);
          await executeSpecialProcess(actionCfg.specialProcess, page, uid, analysis, DRY_RUN, bodyNaibuTexts);
        }

        if (actionCfg.searchTarget) {
          const useCurrentRow = actionCfg.useCurrentRow === true;
          console.log(`[JSON] subAction searchTarget="${actionCfg.searchTarget}" useCurrentRow=${useCurrentRow}`);
          try {
            replyData = getReplyFromCSVByTarget(parsed.charaId, actionCfg.searchTarget, useCurrentRow, fileId);
          } catch (e) {
            console.error(`[ERROR] subAction searchTarget CSV取得失敗 (${userName}): ${e.message} | charaId=${parsed.charaId} fileId=${fileId} target=${actionCfg.searchTarget}`);
            skipUser = true;
          }
        }

        // branch設定がある場合: A/B判定してCSV取得（searchTargetがない場合も対応）
        if (!replyData && !skipUser && actionCfg.branch) {
          const latestText = bodyNaibuTexts.length > 0 ? bodyNaibuTexts[0] : (analysis.latestUserTexts?.[0] || '');
          console.log(`[BRANCH] 判定対象テキスト: "${latestText.slice(0, 60)}"`);
          const branchChoice = detectBranchChoice([latestText]);
          const branchTarget = branchChoice === 'A' ? actionCfg.branch.positive : actionCfg.branch.negative;
          console.log(`[JSON] subAction branch自動判定: ${branchChoice} → ${branchTarget} (charaId=${parsed.charaId} fileId=${fileId})`);
          try {
            replyData = getReplyFromCSVByTarget(parsed.charaId, branchTarget, true, fileId);
          } catch (e) {
            console.error(`[ERROR] subAction branch CSV取得失敗 (${userName}): ${e.message} | charaId=${parsed.charaId} fileId=${fileId} target=${branchTarget}`);
            skipUser = true;
          }
        }

        // useHistorySearch: 履歴から最新sinko/hisコメントを検索し、その次行を
        // 送信する（hoのフォールバック処理=historySinkoComments と同じロジック）
        if (!replyData && !skipUser && actionCfg.useHistorySearch) {
          const historyComments = analysis.allKanteishiComments || [];
          const historySinkoComments = historyComments.filter(c => /(?:sinko|his\w*)\/?(\d+)/.test(c));

          if (historySinkoComments.length === 0) {
            console.log(`[SKIP] ${userName}: subAction useHistorySearch・履歴にsinko/hisコメントなし (${parsed.actionKey})`);
            skipUser = true;
          } else {
            const histSinkoNums = historySinkoComments
              .map(c => { const m = c.match(/(?:sinko|his\w*)\/?(\d+)/); return m ? parseInt(m[1], 10) : null; })
              .filter(n => n !== null);
            const maxSinko = Math.max(...histSinkoNums);
            latestComment = historySinkoComments.find(c => {
              const m = c.match(/(?:sinko|his\w*)\/?(\d+)/);
              return m && parseInt(m[1], 10) === maxSinko;
            }) || latestComment;

            console.log(`[JSON] subAction useHistorySearch: sinko+1 charaId=${parsed.charaId} maxSinko=${maxSinko}`);
            try {
              replyData = getReplyFromCSV(parsed.charaId, maxSinko);
            } catch (e) {
              console.error(`[ERROR] subAction useHistorySearch CSV取得失敗 (${userName}): ${e.message}`);
              skipUser = true;
            }
          }
        }

        if (replyData) break;
      }

      if (skipUser || !replyData) {
        if (!skipUser) console.log(`[SKIP] ${userName}: subAction replyData取得失敗`);
        continue;
      }
    } else if (hasHo) {
      const hoComment = hoComments[0];
      latestComment = hoComment;

      // hoコメントから baseId・typeNum・hoType を抽出
      // 例: "12668mu3sinko/ho"   → baseId=12668, typeNum=mu3sinko, hoType=ho
      // 例: "12668yu3/ho"        → baseId=12668, typeNum=yu3,      hoType=ho
      // 例: "12668mu2zenhan/ho1" → baseId=12668, typeNum=mu2zenhan, hoType=ho1
      // 例: "12673yu1/sinko/ho"  → baseId=12673, typeNum=yu1,      hoType=ho（sinko挟み込み形式）
      const hoMatch = hoComment.match(/^(\d+)((?:yu|mu)\d+\w*)\/(?:sinko\/)?(\w+)$/);

      let hoBaseId = null;
      let hoTypeNum = null;
      let hoType = null;
      if (hoMatch) {
        hoBaseId  = hoMatch[1];
        hoTypeNum = hoMatch[2];
        hoType    = hoMatch[3];
        charaId   = hoBaseId + hoTypeNum;
      }

      // JSON設定の読み込みとphase解決
      const hoCharaCfg   = hoBaseId ? loadCharaConfig(hoBaseId) : null;
      const hoPhaseResult = (hoCharaCfg && hoTypeNum) ? resolveHoPhase(hoCharaCfg, hoTypeNum, hoType) : null;
      let hoPhaseCfg   = hoPhaseResult?.cfg ?? null;
      if (isPhaseBlocked(hoPhaseCfg)) {
        console.log(`[TIME] ${userName}: hoPhase "${hoPhaseResult?.key}" 時間帯制限 → フォールバックへ`);
        hoPhaseCfg = null;
      }
      const hoFileId     = hoPhaseCfg?.fileId ?? null;

      // actionCfg決定: 完全一致優先 → 数値サフィックス除去で前方一致
      let hoActionCfg = null;
      if (hoPhaseCfg && hoType) {
        hoActionCfg = hoPhaseCfg[hoType] ?? null;
        if (!hoActionCfg) {
          const baseKey = hoType.replace(/\d+$/, '');
          if (baseKey !== hoType && hoPhaseCfg[baseKey]) {
            hoActionCfg = hoPhaseCfg[baseKey];
            console.log(`[JSON] hoType="${hoType}" 完全一致なし → baseKey="${baseKey}" で前方一致`);
          }
        }
      }

      // action設定（hoActionCfg）自体にactiveFrom/stopAfter/activeUntilが
      // 入っているケース（例: yu1.ho1.activeFrom）もあるため、phase側だけでなく
      // action側の時間帯制限も個別にチェックする
      if (hoActionCfg && isPhaseBlocked(hoActionCfg)) {
        console.log(`[TIME] ${userName}: hoAction "${hoType}" 時間帯制限 → フォールバックへ`);
        hoActionCfg = null;
      }

      console.log(`[COMMENT] ${userName}: /hoモード comment="${hoComment}" hoType="${hoType}" phase=${hoPhaseResult?.key} actionCfg=${JSON.stringify(hoActionCfg)}`);

      // ─── JSON設定に基づく処理分岐 ────────────────────────────────
      if (hoActionCfg) {
        if (hoActionCfg.specialProcess) {
          console.log(`[JSON] ho specialProcess: ${JSON.stringify(hoActionCfg.specialProcess)}`);
          await executeSpecialProcess(hoActionCfg.specialProcess, page, uid, analysis, DRY_RUN, bodyNaibuTexts);
        }

        if (hoActionCfg.branch) {
          const latestText = bodyNaibuTexts.length > 0 ? bodyNaibuTexts[0] : (analysis.latestUserTexts?.[0] || '');
          console.log(`[BRANCH] 判定対象テキスト: "${latestText.slice(0, 60)}"`);
          const branchChoice = detectBranchChoice([latestText]);
          const branchTarget = branchChoice === 'A' ? hoActionCfg.branch.positive : hoActionCfg.branch.negative;
          console.log(`[JSON] ho分岐自動判定: ${branchChoice} → ${branchTarget}`);
          try {
            replyData = getReplyFromCSVByTarget(charaId, branchTarget, true, hoFileId);
          } catch (e) {
            console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
            continue;
          }
        } else if (hoActionCfg.timeBasedSearch) {
          const now = new Date();
          const curMin = now.getHours() * 60 + now.getMinutes();
          let selected = null;
          for (const [cKey, cVal] of Object.entries(hoActionCfg.timeBasedSearch)) {
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
            console.log(`[JSON] ho timeBasedSearch: 一致する時間帯なし → スキップ`);
            continue;
          }
          const useCurrentRow = selected.useCurrentRow === true;
          console.log(`[JSON] ho timeBasedSearch → "${selected.searchTarget}" useCurrentRow=${useCurrentRow}`);
          try {
            replyData = getReplyFromCSVByTarget(charaId, selected.searchTarget, useCurrentRow, hoFileId);
          } catch (e) {
            console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
            continue;
          }
        } else if (hoActionCfg.searchTarget) {
          const useCurrentRow = hoActionCfg.useCurrentRow === true;
          console.log(`[JSON] ho searchTarget="${hoActionCfg.searchTarget}" useCurrentRow=${useCurrentRow}`);
          try {
            replyData = getReplyFromCSVByTarget(charaId, hoActionCfg.searchTarget, useCurrentRow, hoFileId);
          } catch (e) {
            console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
            continue;
          }
        } else if (hoActionCfg.nextTarget) {
          console.log(`[JSON] ho nextTarget="${hoActionCfg.nextTarget}"`);
          try {
            replyData = getReplyFromCSVByTarget(charaId, hoActionCfg.nextTarget, true, hoFileId);
          } catch (e) {
            console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
            continue;
          }
        }
        // useHistorySearch: true 等はフォールバックに委ねる
      }

      // ─── フォールバック: JSON設定なし or searchTarget系なし ──────
      // 全履歴からsinko/hisコメントを検索してsinko+1を送信
      if (!replyData) {
        const historyComments = analysis.allKanteishiComments || [];
        const historySinkoComments = historyComments.filter(c => /(?:sinko|his\w*)\/?(\d+)/.test(c));

        if (!charaId) {
          for (const c of historySinkoComments) {
            const m = c.match(/^(\d+(?:yu|mu)\d+)/);
            if (m) { charaId = m[1]; break; }
          }
        }

        if (!charaId || historySinkoComments.length === 0) {
          console.log(`[SKIP] ${userName}: /hoあり・履歴にsinko/hisコメントなし・JSON設定もなし`);
          continue;
        }

        const histSinkoNums = historySinkoComments
          .map(c => { const m = c.match(/(?:sinko|his\w*)\/?(\d+)/); return m ? parseInt(m[1], 10) : null; })
          .filter(n => n !== null);
        const maxSinko = Math.max(...histSinkoNums);
        if (!latestComment || latestComment === hoComment) {
          latestComment = historySinkoComments.find(c => {
            const m = c.match(/(?:sinko|his\w*)\/?(\d+)/);
            return m && parseInt(m[1], 10) === maxSinko;
          }) || hoComment;
        }

        console.log(`[COMMENT] ${userName}: /hoフォールバック sinko+1 charaId=${charaId} maxSinko=${maxSinko}`);
        try {
          replyData = getReplyFromCSV(charaId, maxSinko);
        } catch (e) {
          console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
          continue;
        }
      }
    } else {
      // 通常の sinko/his 処理（hisu等のhis変形も含む）
      const sinkoComments = allComments.filter(c => /(?:sinko|his\w*)\/?(\d+)/.test(c));

      const sinkoNums = sinkoComments
        .map(c => { const m = c.match(/(?:sinko|his\w*)\/?(\d+)/); return m ? parseInt(m[1], 10) : null; })
        .filter(n => n !== null);

      // charaId を抽出（複合コメント形式にも対応）
      for (const c of sinkoComments) {
        const m = c.match(/^(\d+(?:yu|mu)\d+)/);
        if (m) { charaId = m[1]; break; }
      }

      // sinkoが1件のみ かつ 番号が1 → スキップ（hisコメントは除外）
      const hasHisComment = sinkoComments.some(c => /\/his\w*/.test(c));
      if (!hasHisComment && sinkoNums.length === 1 && sinkoNums[0] === 1) {
        console.log(`[SKIP] ${userName}: sinko1のみ（初回メッセージ）`);
        continue;
      }

      console.log(`[COMMENT] ${userName}: charaId=${charaId} sinkoNums=${JSON.stringify(sinkoNums)}`);

      // ─── JSON設定の読み込み ──────────────────────────────────────
      const maxSinkoNum = Math.max(...sinkoNums);
      latestComment = sinkoComments.find(c => {
        const m = c.match(/(?:sinko|his\w*)\/?(\d+)/);
        return m && parseInt(m[1], 10) === maxSinkoNum;
      });
      const parsed     = latestComment ? parseCommentStr(latestComment) : null;
      const baseCharaId = parsed?.baseId ?? (charaId?.match(/^(\d+)/)?.[1] ?? null);
      const charaCfg   = baseCharaId ? loadCharaConfig(baseCharaId) : null;
      const phaseResult = (parsed && charaCfg) ? resolvePhaseCfg(parsed, charaCfg) : null;
      let phaseCfg   = phaseResult?.cfg ?? null;
      if (isPhaseBlocked(phaseCfg)) {
        console.log(`[TIME] ${userName}: phase "${phaseResult?.key}" 時間帯制限 → 通常ルールへ`);
        phaseCfg = null;
      }
      const fileId     = phaseCfg?.fileId ?? null;
      const actionKey  = parsed ? `${parsed.type}${parsed.num}` : null;
      const actionCfg  = (phaseCfg && actionKey) ? (phaseCfg[actionKey] ?? null) : null;

      console.log(`[JSON] baseCharaId=${baseCharaId} phase=${phaseResult?.key} action=${actionKey} config=${JSON.stringify(actionCfg)}`);

      // ─── JSON設定に基づく処理分岐 ────────────────────────────────
      if (actionCfg) {
        if (actionCfg.specialProcess) {
          console.log(`[JSON] specialProcess: ${JSON.stringify(actionCfg.specialProcess)}`);
          await executeSpecialProcess(actionCfg.specialProcess, page, uid, analysis, DRY_RUN, bodyNaibuTexts);
        }

        if (actionCfg.branch) {
          // A/B分岐: 最新ユーザーメッセージ1件のみでキーワード判定
          const latestText = bodyNaibuTexts.length > 0 ? bodyNaibuTexts[0] : (analysis.latestUserTexts?.[0] || '');
          console.log(`[BRANCH] 判定対象テキスト: "${latestText.slice(0, 60)}"`);
          const branchChoice = detectBranchChoice([latestText]);
          const branchTarget = (branchChoice === 'A')
            ? actionCfg.branch.positive
            : actionCfg.branch.negative;
          console.log(`[JSON] 分岐自動判定: ${branchChoice} → ${branchTarget}`);
          try {
            replyData = getReplyFromCSVByTarget(charaId, branchTarget, true, fileId);
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
        } else if (actionCfg.nextTarget) {
          console.log(`[JSON] nextTarget="${actionCfg.nextTarget}"`);
          try {
            replyData = getReplyFromCSVByTarget(charaId, actionCfg.nextTarget, true, fileId);
          } catch (e) {
            console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
            continue;
          }
        }
        // specialProcessのみなど、searchTarget系設定がない場合はデフォルト動作へ
      }

      // ─── searchOverride チェック ─────────────────────────────────
      // sinko/3/A 等で parseCommentStr=null → phaseCfg=null でも解決できるよう
      // charaId から typeNum を抽出してフォールバック解決する
      if (!replyData && latestComment && charaCfg) {
        const ovPhase = phaseCfg ?? (() => {
          const tn = charaId?.match(/(?:yu|mu)\d+/)?.[0];
          return tn ? (charaCfg.phases?.[tn] ?? null) : null;
        })();
        const ovFileId = fileId ?? ovPhase?.fileId ?? null;

        if (ovPhase?.searchOverride) {
          const overrideCfg = ovPhase.searchOverride[latestComment];
          if (overrideCfg?.searchTarget) {
            const useCurrentRow = overrideCfg.useCurrentRow === true;
            console.log(`[JSON] searchOverride: "${latestComment}" → searchTarget="${overrideCfg.searchTarget}" useCurrentRow=${useCurrentRow}`);
            try {
              replyData = getReplyFromCSVByTarget(charaId, overrideCfg.searchTarget, useCurrentRow, ovFileId);
            } catch (e) {
              console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
              continue;
            }
          }
        }
      }

      // ─── デフォルト動作（JSON設定なし、またはsearchTarget系設定なし）──
      if (!replyData) {
        // 複数コメントが全て同じ番号の場合のみspan検索（1件のみはsinko+1）
        const allSameNum = sinkoNums.length > 1 && sinkoNums.every(n => n === sinkoNums[0]);

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
      `ユーザー：${userName}（u_id: ${uid}）`,
      `対象コメントアウト：${latestComment || '（不明）'}`,
      ...(analysis.hasConsultation ? [
        '【相談あり】',
        '相談内容：',
        '---',
        (analysis.consultationTexts || []).join('\n'),
        '---',
      ] : []),
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
      // 返信文 + 次のコメントアウトを末尾に追記（先頭・末尾の余分な改行を除去）
      const textToSend = replyData.replyText.replace(/\\n/g, '\n').trim() + '\n' + replyData.nextComment;
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

        // 本文：返信文 + 改行 + 次のコメントアウト
        await sendFrame.fill('textarea#mess_body', textToSend);

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

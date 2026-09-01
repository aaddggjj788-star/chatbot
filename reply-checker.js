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
const { sendSlack, isSlackOnly } = require('./slack-notify');
const { checkReplySafety } = require('./reply-safety');

const REPLY_SAFETY_IGNORE_FILE = path.join(
  __dirname,
  'reply-safety-ignore.json'
);


function loadReplySafetyIgnoreComments() {
  try {
    if (!fs.existsSync(REPLY_SAFETY_IGNORE_FILE)) {
      return new Set();
    }

    const config = JSON.parse(
      fs.readFileSync(REPLY_SAFETY_IGNORE_FILE, 'utf8')
    );

    const list = Array.isArray(config.ignoreComments)
      ? config.ignoreComments
      : [];

    return new Set(
      list
        .map(v => String(v).trim())
        .filter(Boolean)
    );

  } catch (err) {
    console.error(
      '[REPLY-SAFETY] 除外設定読込エラー:',
      err.message
    );

    return new Set();
  }
}

const LOGIN_URL   = process.env.SYSTEM_URL || 'http://manager.x7j4l2p9m1.com/mg/mg_ope.php';
const BASE_URL    = LOGIN_URL.replace(/[^/]+$/, ''); // "http://manager.x7j4l2p9m1.com/mg/"
// 親フレーム: mg_ope.php  左: iframe[name="ope_menu"]  右: iframe[name="ope_main"]
const LINE_TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CSV_DIR = process.env.REPLY_CSV_DIR || path.join(__dirname, 'reply-csv');
const CHARA_CONFIG_DIR = path.join(__dirname, 'chara-config');
const DRY_RUN = process.env.DRY_RUN === 'true';

const STATE_FILE = '/tmp/rune-reply-state.json';
// 返信チェック完了時の対象外ユーザー一覧（番号付き）を保存するファイル。
// 「対象外ID:{番号} {返信文章}」コマンドで番号→uid/kidを解決するために使う。
const SKIPPED_LIST_FILE = '/tmp/rune-skipped-list.json';
const POLL_INTERVAL_MS = 2000;
const REPLY_TIMEOUT_MS = 5 * 60 * 1000; // 5分

let _shouldStop = false;

// 今回の返信チェックで対象外となったユーザー
// [{ userName, uid, kid, reason }]
let skippedUsers = [];

// 返信チェック完了時にLINEへ通知する対象外ユーザー一覧を組み立てる
// 連番（1始まり）・u_id・k_id・理由を1行ずつ番号付きで表示する
function buildSkippedMessage() {
  if (skippedUsers.length === 0) {
    return '【返信チェック完了】\n対象外ユーザーはいませんでした';
  }

  const lines = skippedUsers.map(
    (u, i) => `${i + 1}. ${u.userName}（u_id: ${u.uid || '不明'}, k_id: ${u.kid || '不明'}）理由：${u.reason}`
  );

  // LINEの1メッセージ上限（5000文字）を超えると送信できないため、
  // 超える場合は件数を打ち切って残件数を末尾に付ける
  const MAX_LEN = 4800;
  const shown = [];
  let len = '【返信チェック完了】\n対象外ユーザー：'.length;
  for (const line of lines) {
    if (len + line.length + 1 > MAX_LEN) break;
    shown.push(line);
    len += line.length + 1;
  }
  const rest = lines.length - shown.length;

  return [
    '【返信チェック完了】',
    '対象外ユーザー：',
    ...shown,
    ...(rest > 0 ? [`（ほか${rest}件は文字数上限のため省略）`] : []),
  ].join('\n');
}

// 対象外ユーザー一覧を番号付きで SKIPPED_LIST_FILE に保存する。
// 「対象外ID:{番号} {返信文章}」コマンドで番号→uid/kidを解決するために使う。
// 保存形式: [{ index, uid, kid, userName }, ...]（indexはbuildSkippedMessageの番号と一致）
function saveSkippedList() {
  const list = skippedUsers.map((u, i) => ({
    index: i + 1,
    uid: u.uid || '',
    kid: u.kid || '',
    userName: u.userName || '',
  }));
  try {
    fs.writeFileSync(SKIPPED_LIST_FILE, JSON.stringify(list, null, 2));
    console.log(`[SKIPPED-LIST] ${list.length}件を ${SKIPPED_LIST_FILE} に保存`);
  } catch (e) {
    console.error(`[SKIPPED-LIST] 保存に失敗: ${e.message}`);
  }
}

// 対象外一覧ファイルを空配列でリセットする（新しい返信チェック開始時に上書き）
function resetSkippedList() {
  try {
    fs.writeFileSync(SKIPPED_LIST_FILE, JSON.stringify([], null, 2));
    console.log(`[SKIPPED-LIST] ${SKIPPED_LIST_FILE} をリセット`);
  } catch (e) {
    console.error(`[SKIPPED-LIST] リセットに失敗: ${e.message}`);
  }
}

// ─── LINE / Slack 送信 ────────────────────────────────────────────

async function sendLine(message) {
  // Slackへ同じ内容を送る（SLACK_WEBHOOK_URL未設定なら何もしない）
  await sendSlack(message);

  // SLACK_ONLY=true かつ SLACK_WEBHOOK_URL設定ありのときはLINE送信を行わない。
  // それ以外（SLACK_ONLY=false / SLACK_WEBHOOK_URL未設定）は従来どおりLINEへ送る。
  if (isSlackOnly()) return;

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
// 単純形式: "12668mu1/sinko/2"    → { baseId:"12668", typeNum:"mu1", sub:null, type:"sinko", num:2, suffix:null }
//           "12668mu1/his/2"     → { ..., type:"his", num:2 }
//           "12668mu1/hisu/2"    → { ..., type:"his", num:2 }（his*はhisに正規化）
//           "12668mu2/his/3/B"   → { ..., type:"his", num:3, suffix:"B" }（数字後の/A,/B等のsuffix対応）
// 複合形式: "12668mu2/zenhan/sinko/1" → { baseId:"12668", typeNum:"mu2", sub:"zenhan", type:"sinko", num:1, suffix:null }
// do形式:  "12684mu1/do/1"      → { baseId:"12684", typeNum:"mu1", sub:null, type:"do", num:1, suffix:null }
// ho形式:  "12684yu5/ho"        → { baseId:"12684", typeNum:"yu5", sub:null, type:"ho", num:null, suffix:null }（末尾数字なし）
// ※ numは数値のみ（span範囲比較・actionKey生成のため）。/A,/B等のsuffixはsuffixフィールドに保持する。
// ※ ho等で末尾数字が無い場合はnum:null。
function parseCommentStr(commentStr) {
  // sinko/his に加え、do（例:"12684mu1/do/1"）・ho（例:"12684yu5/ho"）にも対応する。
  // ※ ho は末尾の数字が無い形式もあるため (\d+) を任意にする。
  //   batchSearchAndReply は baseId/typeNum のみ使用するため num=null でも影響しない。
  let m = commentStr.match(/^(\d+)((?:yu|mu)\d+\w*)\/(sinko|his\w*|do|ho)\/?(\d+)?(?:\/?([a-zA-Z]+))?$/);
  if (m) {
    const type = m[3].startsWith('his') ? 'his' : m[3];
    return { baseId: m[1], typeNum: m[2], sub: null, type, num: m[4] ? parseInt(m[4], 10) : null, suffix: m[5] || null };
  }
  m = commentStr.match(/^(\d+)((?:yu|mu)\d+\w*)\/([a-z]+)\/(sinko|his\w*)\/?(\d+)(?:\/?([a-zA-Z]+))?$/);
  if (m) {
    const type = m[4].startsWith('his') ? 'his' : m[4];
    return { baseId: m[1], typeNum: m[2], sub: m[3], type, num: parseInt(m[5], 10), suffix: m[6] || null };
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
  if (/^ho/.test(sub)) return null; // hoコメントはhoモードで処理するため除外
  // "12680yu1/sinko/ho"（sinkoHo）形式はsubActionにせず、hoモードのsinko挟み込み
  // 履歴検索（同一charaIdのsinko/○を検索してsinko+1送信）で処理する
  if (sub === 'sinko' && /^ho\d*$/.test(part3)) return null;
  // part3が英字なら先頭を大文字化してキャメルケースに結合（例: mtm→Mtm, ho→Ho）
  const part3Key = /^\d+$/.test(part3) ? part3 : (part3.charAt(0).toUpperCase() + part3.slice(1));
  const actionKey = sub + part3Key;
  return { baseId: m[1], typeNum: m[2], sub, part3, actionKey, charaId: m[1] + m[2], comment: commentStr };
}

// ho設定のreplaceHeaderで返信文の文頭部分を差し替える
// ・<imgタグがある場合: <imgタグより上をreplaceHeaderに置換（<img以降はそのまま残す）
// ・<imgタグがない場合: 文頭3行をreplaceHeaderに置換
// ※返信文の改行はCSV由来のリテラル "\n" のため、行分割もリテラル "\n" で行う
function applyReplaceHeader(replyText, replaceHeader) {
  if (!replyText) return replaceHeader;
  const imgMatch = replyText.match(/<img/i);
  if (imgMatch) {
    return `${replaceHeader}\n${replyText.slice(imgMatch.index)}`;
  }
  const lines = replyText.split('\\n');
  const rest = lines.slice(3).join('\\n');
  return rest ? `${replaceHeader}\n${rest}` : replaceHeader;
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

// fileIdからcharaId部分を抽出する（例: "12676yu5sinko" → "12676yu5"、"12680mu2his" → "12680mu2"）
// 抽出できない場合はnullを返す
function charaIdFromFileId(fileId) {
  if (!fileId) return null;
  const m = fileId.match(/^(\d+(?:yu|mu)\d+\w*?)(?:sinko|his\w*)$/);
  return m ? m[1] : null;
}

// fileId指定時、検索対象文字列(target)先頭のcharaId部分を実行時charaIdから
// fileId由来のcharaIdに置き換える。
// minPhaseNumberでyu7がyu5の設定・CSV（fileId="12676yu5sinko"）を流用する場合、
// 実際のコメントは"12676yu7/..."だがCSV内は"12676yu5/..."で書かれているため、
// 検索前に置換しないとヒットしない（charaId・fileId由来charaIdが一致する場合や
// targetがcharaIdで始まらない場合はそのまま返す）
function rewriteTargetCharaId(target, charaId, fileId) {
  const fileCharaId = charaIdFromFileId(fileId);
  if (!fileCharaId || !charaId || fileCharaId === charaId) return target;
  if (!target.startsWith(charaId + '/')) return target;
  return fileCharaId + target.slice(charaId.length);
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

  // charaIdで始まるCSVを検索
  // まず {prefix}sinko.csv / {prefix}his.csv の完全一致を最優先で返す。
  // これにより「12679yu1」で「12679yu1amsinko.csv」等の別phase変種を誤って
  // 拾わず、「12679yu1sinko.csv」を確実に選択できる。
  // 完全一致がない場合のみ従来のprefix検索（時間帯変種 hirusinko等を拾う）に委ねる。
  function findByPrefix(prefix) {
    const exact = [`${prefix}sinko.csv`, `${prefix}his.csv`].find(n => files.includes(n));
    if (exact) return exact;
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
      // 数値の直後に別サブタイプ(yu/mu)が続くファイル(例: yu4mu)は別系統として除外する
      // 有効なサフィックス(sinko/his/kouhansinko/yorusinko等)は英字始まりだが yu/mu では始まらない
      const fm = f.match(new RegExp(`^${baseId}${type}(\\d+)(?!mu|yu)`));
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

function getReplyFromCSV(charaId, sinkoNum, fileId) {
  const { csvPath, resolvedCharaId } = resolveCsvPath(charaId, fileId);
  if (!fs.existsSync(csvPath)) throw new Error(`CSVなし: ${csvPath}`);

  const rows = parseCSV(csvPath);
  console.log(`[CSV] 総行数: ${rows.length}`);

  // 1行目(rows[0])は件名データとして使用する
  const title = rows[0] ? (rows[0][0] || '') : '';
  console.log(`[CSV] 1行目A列(件名): "${title}"`);

  // sinko/N または his/N の行を特定する（sinko/2・sinko2・sinko/3/A 等に対応）
  // fileId明示指定時はresolvedCharaIdがfileId自体に置き換わるため、
  // コメント内のプレフィックス（charaId）とは一致しない。その場合は
  // fileIdから抽出したcharaIdをパターンに使う（例: fileId="12676yu5sinko"
  // → "12676yu5"。minPhaseNumberでyu7がyu5のCSVを流用する場合、CSV内の
  // コメントは"12676yu5/..."で書かれているため、実行時charaId="12676yu7"を
  // そのまま使うとヒットしない）。抽出できなければ従来通りcharaIdにフォールバック。
  // fileId未指定時は従来通りresolvedCharaIdを使用する。
  const patternCharaId = fileId ? (charaIdFromFileId(fileId) ?? charaId) : resolvedCharaId;
  const sinkoPattern = new RegExp(
    `<!--${patternCharaId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/(?:sinko|his)\\/?${sinkoNum}(?:\\/[A-Za-z0-9]+)?-->"?`
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
  console.log(`[CSV-TARGET] 使用CSVファイル: ${csvPath}`);
  if (!fs.existsSync(csvPath)) throw new Error(`CSVなし: ${csvPath}`);
  const rows = parseCSV(csvPath);
  const title = rows[0] ? (rows[0][0] || '') : '';

  // fileId指定時、searchTarget先頭のcharaIdが実行時charaIdのままだと
  // fileId由来のCSV（例: minPhaseNumberでyu7がyu5のCSVを流用するケース）内の
  // "12676yu5/..."と一致しないため、fileIdから抽出したcharaIdに書き換える
  const effectiveTarget = fileId ? rewriteTargetCharaId(searchTarget, charaId, fileId) : searchTarget;
  if (effectiveTarget !== searchTarget) {
    console.log(`[CSV-TARGET] fileId="${fileId}" のためcharaIdを書き換え: "${searchTarget}" → "${effectiveTarget}"`);
  }

  // 特殊文字をエスケープしつつ、数字の直前スラッシュは省略形も許容（his/2 ↔ his2）
  const escaped = effectiveTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flexEscaped = escaped.replace(/\/(\d)/g, '\\/?$1');
  const pattern = new RegExp(`<!--${flexEscaped}-->"?`);

  console.log(`[CSV-TARGET] 検索: "${effectiveTarget}" pattern=${pattern}`);

  const idx = rows.findIndex(r => pattern.test((r[0] || '').trim()));
  if (idx === -1) {
    const sample = rows.slice(0, 10).map((r, i) => `  row[${i}]: "${(r[0] || '').trim().slice(0, 60)}"`).join('\n');
    throw new Error(`searchTarget "${effectiveTarget}" がCSVに未発見\nCSV先頭10行:\n${sample}`);
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

// ─── テンプレート差し替え・差し込み ─────────────────────────────────
// reply-templates/{baseId}.json（baseId = charaIdの数値部分、例: 12676yu5 → 12676）
// から指定IDのテンプレート本文を取得する。
// 入力が「テンプレート{番号}」形式の場合のみ該当テンプレートのtextに置換し、
// それ以外（通常の手入力文章）は入力をそのまま返す。
// ファイル・テンプレートが見つからない場合も入力をそのまま返す。
function resolveTemplateText(charaId, inputText) {
  const m = String(inputText).match(/^テンプレート(\d+)$/);
  if (!m) return inputText;
  const templateId = parseInt(m[1], 10);

  // charaId（例: "12676yu5"）の数値プレフィックス（baseId "12676"）を取り出す
  const baseId = (String(charaId).match(/^(\d+)/) || [])[1];
  if (!baseId) {
    console.log(`[TEMPLATE] charaId="${charaId}" からbaseIdを抽出できませんでした`);
    return inputText;
  }

  const templatePath = path.join(__dirname, 'reply-templates', `${baseId}.json`);
  if (!fs.existsSync(templatePath)) {
    console.log(`[TEMPLATE] テンプレートファイルなし: ${templatePath}`);
    return inputText;
  }
  try {
    const templates = JSON.parse(fs.readFileSync(templatePath, 'utf8')).templates || [];
    const template = templates.find(t => t.id === templateId);
    if (template) {
      console.log(`[TEMPLATE] baseId=${baseId} id=${templateId}（${template.name}）を適用`);
      return template.text;
    }
    console.log(`[TEMPLATE] baseId=${baseId} id=${templateId} のテンプレートが見つかりません`);
  } catch (e) {
    console.log(`[TEMPLATE] テンプレート読み込みエラー: ${e.message}`);
  }
  return inputText;
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

async function loginWithRetry(page, retryCount = 2) {
  let lastError = null;

  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      console.log(`[LOGIN] 試行 ${attempt}/${retryCount}`);

      await login(page);

      console.log(`[LOGIN] 試行 ${attempt}/${retryCount} 成功`);
      return;

    } catch (err) {
      lastError = err;

      console.error(
        `[LOGIN] 試行 ${attempt}/${retryCount} 失敗: ${err.message}`
      );

      if (attempt < retryCount) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }

  const error = new Error('AUTO_REPLY_LOGIN_FAILED');
  error.cause = lastError;

  throw error;
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


async function openSupportPageWithRetry(page, retryCount = 2) {
  let lastError = null;

  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      console.log(
        `[PAGE] サポートページ試行 ${attempt}/${retryCount}`
      );

      const supportPage = await openSupportPage(page);

      // 初期フレームが本当に取れるか確認
      const menuFrame = page.frame({ name: 'ope_menu' });

      if (!menuFrame) {
        throw new Error('ope_menuフレーム取得失敗');
      }

      console.log(
        `[PAGE] サポートページ試行 ${attempt}/${retryCount} 成功`
      );

      return supportPage;

    } catch (err) {
      lastError = err;

      console.error(
        `[PAGE] サポートページ試行 ${attempt}/${retryCount} 失敗: ${err.message}`
      );

      if (attempt < retryCount) {
        await new Promise(resolve =>
          setTimeout(resolve, 3000)
        );
      }
    }
  }

  const error = new Error('AUTO_REPLY_PAGE_LOAD_FAILED');
  error.cause = lastError;

  throw error;
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

// alwaysQuoteUser用: ユーザーメッセージの引用テキストを組み立てる
// bodyNaibuTextsが複数ある場合は全てを\n\nで結合して1ブロックにする
// bodyNaibuTextsが取得できない場合は最も文字数の多いメッセージを使用する
function buildQuoteText(bodyNaibuTexts, analysis) {
  if (bodyNaibuTexts && bodyNaibuTexts.length > 0) {
    return bodyNaibuTexts.map(userText => userText.slice(0, 500)).join('\n\n');
  }
  const fallbackTexts = analysis?.latestUserTexts || [];
  if (fallbackTexts.length === 0) return '';
  const userText = fallbackTexts.reduce((longest, t) => (t.length > longest.length ? t : longest), fallbackTexts[0]);
  const quotedText = userText.slice(0, 500);
  return quotedText;
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

// 念言テキストから検索ワードを抽出する
// 【】≪≫《》()（）「」『』[]等の括弧類を区切りとして分割し、各パーツから
// 漢字・ひらがな・カタカナのみを抽出、2文字以上のパーツのみを採用する
// （念言全体との完全一致ではなく、ユーザーが一部だけ送ってきた場合にも
//  マッチできるようにするため）
function extractNengenKeywords(text) {
  const parts = String(text).split(/[【】≪≫《》()（）「」『』\[\]]/);
  const keywords = [];
  for (const part of parts) {
    const cleaned = part.replace(/[^一-鿿぀-ゟ゠-ヿ]/g, '');
    if (cleaned.length >= 2) keywords.push(cleaned);
  }
  return keywords;
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

  const { result, lastKIdx, afterUserCount, debugLogs } = await mainFrame.evaluate(() => {
    function normStyle(el) {
      return (el.getAttribute('style') || '').replace(/\s/g, '').toLowerCase();
    }

    // ── メッセージ収集: DOM順（上=新しい → 下=古い）で走査 ──────
    // 上（tr番号小）= 新しいメッセージ、下（tr番号大）= 古いメッセージ。
    // tr自体またはtr内のtdに背景色が設定されている場合の両方を拾う。
    const msgs = [];
    const debugLogs = [];
    let totalTr = 0;
    let greenTr = 0;
    for (const trEl of document.querySelectorAll('tr')) {
      totalTr++;
      const trBg = normStyle(trEl);
      const tdBg = Array.from(trEl.querySelectorAll('td'))
        .map(td => normStyle(td)).join('');
      const bg = trBg + tdBg;
      if (bg.includes('90ee90') || bg.includes('144,238,144')) {
        greenTr++;
        // コメントアウトは innerHTML だと &lt;!--...--&gt; にエンコードされるため
        // hidden input の value 属性から生テキストを取得して正規表現で抽出する
        const trHtml = trEl.innerHTML; // デバッグ用
        const trText = trEl.textContent || ''; // 既/未判定用
        const bodyInput = trEl.querySelector('input[type="hidden"][id^="body_"]');
        let bodyText;
        if (bodyInput) {
          bodyText = bodyInput.value;
        } else {
          // hidden inputがないページ: div.bodyNaibuのtextContentにHTMLエンティティ
          // 形式（&lt;!--...--&gt;）でコメントアウトが入っているためデコードする
          const bodyNaibuEl = trEl.querySelector('div.bodyNaibu');
          const rawText = bodyNaibuEl ? (bodyNaibuEl.textContent || '') : '';
          bodyText = rawText
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
        }
        if (bodyText.includes('sinko')) {
          console.log('[DEBUG] sinko含むbodyText(末尾100):', JSON.stringify(bodyText.slice(-100)));
        }
        // bodyTextにコメントアウトがHTMLエンティティ形式（&lt;!--...--&gt;）や
        // JavaScriptエスケープ形式（\x3C!--...-->）で入っている場合があるため
        // デコードしてから抽出する
        const decodedBody = bodyText
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .replace(/\x3C/g, '<')
          .replace(/\x3E/g, '>');
        const comments = [];
        const cre = /<!--([^>]+)-->/g;
        let cm;
        while ((cm = cre.exec(decodedBody)) !== null) { comments.push(cm[1]); }
        const debugMsg = `kanteishi tr found, bodyInput=${bodyInput ? bodyInput.id : 'null'}, bodyText.length=${bodyText ? bodyText.length : 0}`;
        debugLogs.push(debugMsg);
        msgs.push({ type: 'kanteishi', html: trEl.innerHTML, trHtml, trText, bodyText, comments });
      } else if (bg.includes('aaaaff') || bg.includes('ffaaaa')) {
        const timeTd = trEl.querySelector('td[style*="width:110px"]');
        const timeText = timeTd ? timeTd.textContent.trim() : '';
        const fullRowText = trEl.textContent || '';
        msgs.push({ type: 'user', rowText: fullRowText, timeText });
      }
    }
    debugLogs.push(`totalTr=${totalTr} greenTr=${greenTr}`);

    const emptyK = { kanteishiHtml: '', kanteishiTrHtml: '', kanteishiBodyText: '', kanteishiComments: [], allKanteishiComments: [], spanCount: 0, userMsgCount: 0, latestUserTime: '', latestUserTexts: [] };

    // 【判定2】最新メッセージチェック（DOM最上位 = 最新）
    if (msgs.length === 0) {
      return { result: { target: false, reason: 'メッセージなし', ...emptyK }, lastKIdx: -1, afterUserCount: 0, debugLogs };
    }
    if (msgs[0].type === 'kanteishi') {
      return { result: { target: false, reason: '最新メッセージが鑑定士（返信済み）', ...emptyK }, lastKIdx: 0, afterUserCount: 0, debugLogs };
    }

    // 最新の鑑定士メッセージを探す
    let firstKIdx = -1;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].type === 'kanteishi') { firstKIdx = i; break; }
    }

    if (firstKIdx === -1) {
      return { result: { target: false, reason: '鑑定士メッセージなし', ...emptyK }, lastKIdx: firstKIdx, afterUserCount: 0, debugLogs };
    }

    // 【判定1.5】最新鑑定士メッセージの既/未チェック（「未」ならスキップ）
    if (!(msgs[firstKIdx].trText || '').includes('既')) {
      return { result: { target: false, reason: '最新鑑定士メッセージが未読', ...emptyK }, lastKIdx: firstKIdx, afterUserCount: 0, debugLogs };
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
      return { result: { target: false, reason: 'ユーザーメッセージに「既」あり', ...emptyK }, lastKIdx: firstKIdx, afterUserCount: beforeUser.length, debugLogs };
    }

    return { result: { target: true, reason: '', ...successK }, lastKIdx: firstKIdx, afterUserCount: beforeUser.length, debugLogs };
  });

  for (const debugMsg of debugLogs || []) {
    console.log(`[DEBUG] ${debugMsg}`);
  }

  // div.bodyNaibuのテキストを取得する。tr全体のtextContent（rowText）には
  // 「未」「07月06日 09時37分」「ユーザー」等のメタ情報が混入するため、
  // 50文字判定・相談判定・相談内容の引用にはこちらを使用する
  const bodyNaibuTexts = await getBodyNaibuTexts(mainFrame);

  // 【追加判定】50文字以上メッセージチェック（bodyNaibuTextsで判定する）
  // スキップはせず、対象コメントアウト・返信文が判明した後にLINEへ確認通知を送る
  // （processUsers側の【返信確認】送信箇所を参照）
  const normalize = (t) => t.replace(/[\t\n\r]/g, '').replace(/\s+/g, ' ').trim();
  const longMessageTexts = bodyNaibuTexts.filter(t => normalize(t).length >= 50).map(t => decodeHtml(t));
  const hasLongMessage = longMessageTexts.length > 0;
  if (hasLongMessage) {
    bodyNaibuTexts.forEach((t, i) => {
      const decoded = decodeHtml(t);
      console.log(`[DEBUG] bodyNaibu[${i}] 文字数=${decoded.length} テキスト="${decoded.slice(0, 80)}"`);
    });
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

  return { ...result, bodyNaibuTexts, hasLongMessage, longMessageTexts };
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

    // ひらがなのみ → そのまま使用（例: たろう→たろう）
    if (/^[ぁ-んー]+$/.test(candidate)) return candidate;
    // カタカナのみ → そのまま使用（例: タロウ→タロウ）
    if (/^[ァ-ヶー]+$/.test(candidate)) return candidate;

    // スペース区切りフルネーム（例: 田中 花子→花子、佐々木 小次郎→佐々木）
    // 苗字+名前が分かれている場合は名前部分のみを抽出（男性名は苗字呼びのため苗字を採用）
    const spaceMatch = candidate.match(/^([^\s　]{1,6})[\s　]+([^\s　]{1,6})$/);
    if (spaceMatch) {
      const [, surname, givenName] = spaceMatch;
      const hasMale   = [...givenName].some(c => MALE_KANJI.includes(c));
      const hasFemale = [...givenName].some(c => FEMALE_KANJI.includes(c));
      if (hasMale)   return surname;
      if (hasFemale) return givenName;
      return givenName; // 不明時も名前部分（後半）を採用
    }

    // 漢字+ひらがな/カタカナのスペースなしフルネーム（例: 田中たろう→たろう、桐林みよこ→みよこ）
    // 苗字（漢字）+名前（かな）が繋がっている場合はかな部分（名前）のみを抽出する
    const kanjiKanaMatch = candidate.match(/^([一-龥々]{1,4})([ぁ-んァ-ヶー]{2,6})$/);
    if (kanjiKanaMatch) return kanjiKanaMatch[2];

    // 漢字のみスペースなしフルネーム（例: 佐藤花子→花子、佐々木小次郎→佐々木）
    // 苗字2-3文字 + 名前2-3文字 で分割し、名前部分のみを抽出（男性名は苗字呼び）
    const kanjiOnlyMatch = candidate.match(/^([一-龥々]{2,3})([一-龥々]{2,3})$/);
    if (kanjiOnlyMatch) {
      const [, surname, givenName] = kanjiOnlyMatch;
      const hasMale   = [...givenName].some(c => MALE_KANJI.includes(c));
      const hasFemale = [...givenName].some(c => FEMALE_KANJI.includes(c));
      if (hasMale)   return surname;
      if (hasFemale) return givenName;
      return givenName; // 不明時も名前部分（後半）を採用
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
async function saveNickname(frame, userText, dryRun, sendLine, waitForLineReply) {
  let { nickname } = extractNickname([userText]);

  if (!nickname) {
    await sendLine(
      `【ニックネーム未取得】\n\n` +
      `ユーザーメッセージ：\n` +
      `---\n` +
      `${userText}\n` +
      `---\n` +
      `ニックネームを抽出できませんでした。\n` +
      `手動で入力するニックネームを送信してください。\n` +
      `（スキップする場合は「スキップ」）`
    );
    const reply = await waitForLineReply();
    if (reply === 'スキップ' || !reply) return;
    nickname = reply;
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
        await saveNickname(mainFrame, latestUserText, dryRun, sendLine, waitForLineReply);
      } else {
        console.log(`[SPECIAL] 未実装のprocess: "${proc}"`);
      }
    }
  } catch (e) {
    console.error(`[SPECIAL ERROR] ${e.message}`);
  }
}

// ======================================================
// 送り返す言葉：自動返信用のゆるい一致判定
// ======================================================

function normalizeMatchText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/<[^>]*>/g, '')
    .replace(/[「」『』【】［］\[\]（）()]/g, '')
    .replace(/[、。,.!！?？・]/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}


// ------------------------------------------------------
// 「財運開門（ざいうんかいもん）」のような形式を分離
// ------------------------------------------------------
function splitWordAndReading(rawWord) {
  const text = String(rawWord || '').trim();

  const m = text.match(
    /^(.+?)[（(]([ぁ-んァ-ヶー]+)[）)]$/
  );

  if (!m) {
    return {
      word: text,
      reading: ''
    };
  }

  return {
    word: m[1].trim(),
    reading: m[2].trim()
  };
}


// ------------------------------------------------------
// 短い造語向け
//
// 完全一致
// ↓
// 読み一致
// ↓
// 1文字程度の誤りを許容
// ------------------------------------------------------
function fuzzyShortWordMatch(userText, word) {
  const user = normalizeMatchText(userText);
  const target = normalizeMatchText(word);

  if (!user || !target) {
    return false;
  }

  const userChars = [...user];
  const targetChars = [...target];

  // --------------------------------------------------
  // ユーザー本文が送り返す言葉より短ければNG
  //
  // 例:
  // 雨情心継ぎ → 5文字
  // 雨継ぎ     → 3文字
  // → NG
  // --------------------------------------------------
  if (userChars.length < targetChars.length) {
    return false;
  }

  // 完全部分一致なら即OK
  if (user.includes(target)) {
    return true;
  }

  // --------------------------------------------------
  // targetと同じ文字数の範囲をユーザー本文から切り出し、
  // 1文字までの違いを許容する
  // --------------------------------------------------
  const targetLength = targetChars.length;

  for (
    let start = 0;
    start <= userChars.length - targetLength;
    start++
  ) {
    const window = userChars.slice(
      start,
      start + targetLength
    );

    let mismatchCount = 0;

    for (let i = 0; i < targetLength; i++) {
      if (window[i] !== targetChars[i]) {
        mismatchCount++;
      }

      // 2文字以上違った時点で不一致
      if (mismatchCount > 1) {
        break;
      }
    }

    // 1文字違いまでならOK
    if (mismatchCount <= 1) {
      return true;
    }
  }

  return false;
}


// ------------------------------------------------------
// 普通の文章から比較用キーワードを作る
//
// 金運を優先したい
// → 金運 / 優先
//
// 幸せを受け入れる
// → 幸せ / 受け入
// ------------------------------------------------------
function extractPhraseKeywords(text) {
  let s = normalizeMatchText(text);

  if (!s) {
    return [];
  }

  // よくある助詞を区切りとして扱う
  s = s
    .replace(/(について|として|によって|から|まで|より|ので|ため)/g, '|')
    .replace(/[をがはにへともでの]/g, '|');

  let parts = s
    .split('|')
    .map(v => v.trim())
    .filter(v => v.length >= 2);

  // 語尾の表記揺れを少し吸収
  parts = parts.map(part =>
    part
      .replace(/したい$/, '')
      .replace(/します$/, '')
      .replace(/する$/, '')
      .replace(/した$/, '')
      .replace(/してください$/, '')
      .replace(/下さい$/, '')
      .replace(/ます$/, '')
      .replace(/です$/, '')
      .replace(/たい$/, '')
      .trim()
  );

  return [
    ...new Set(
      parts.filter(v => v.length >= 2)
    )
  ];
}





function containsNegativeExpression(text) {
  const s = normalizeMatchText(text);

  if (!s) {
    return false;
  }

  // --------------------------------------------------
  // 「ない」を含んでいても肯定になる表現は除外
  // --------------------------------------------------
  const normalizedExceptions =
    NEGATIVE_EXCEPTION_PHRASES.map(normalizeMatchText);

  const textForNegativeCheck =
    normalizedExceptions.reduce(
      (current, phrase) =>
        current.replaceAll(phrase, ''),
      s
    );

  const negativePatterns = [
    /ません/,
    /ない/,
    /しない/,
    /やらない/,
    /進まない/,
    /やめる/,
    /辞める/,
    /断る/,
    /拒否/,
    /無理/,
    /嫌/,
    /できない/,
    /出来ない/,
    /望まない/,
    /希望しない/,
    /必要ない/,
    /必要ありません/
  ];

  return negativePatterns.some(re =>
    re.test(textForNegativeCheck)
  );
}


const NEGATIVE_EXCEPTION_PHRASES = [
  '迷いはない',
  '問題ない',
  '問題ありません',
  '構わない',
  '構いません',
  '不安はない',
  '不安ありません',
  '異論はない',
  '異論ありません',
  '抵抗はない',
  '抵抗ありません',
  '躊躇はない',
  '躊躇ありません'
];


function isPhraseLike(text) {
  const s = normalizeMatchText(text);

  if (!s) {
    return false;
  }

  // 助詞を含む場合は文章型
  if (/[をへにがはとでの]/.test(s)) {
    return true;
  }

  // よくある動詞・意思表現
  const phraseEndings = [
    /する$/,
    /したい$/,
    /進む$/,
    /進める$/,
    /選ぶ$/,
    /受け取る$/,
    /受け入れる$/,
    /望む$/,
    /願う$/,
    /決める$/,
    /決断する$/,
    /優先する$/,
    /信じる$/,
    /変える$/,
    /始める$/,
    /続ける$/,
    /聞く$/,    
    /聞きたい$/,
    /知る$/,
    /ます$/,
    /なる$/
  ];

  return phraseEndings.some(re => re.test(s));
}


// ------------------------------------------------------
// 普通の文章向け一致判定
// ------------------------------------------------------
function phraseMatch(userText, targetText) {
  const user = normalizeMatchText(userText);
  const target = normalizeMatchText(targetText);

  if (!user || !target) {
    return false;
  }

  // --------------------------------------------------
  // 否定表現を最優先で判定
  //
  // 例:
  // 「次へ進む」
  // →「次へ進みません」
  // は文字列が似ていてもNG
  // --------------------------------------------------
  if (containsNegativeExpression(userText)) {
    return false;
  }

  // 完全部分一致
  if (user.includes(target)) {
    return true;
  }

  const keywords = extractPhraseKeywords(target);

  if (keywords.length === 0) {
    return false;
  }

  // 重要語が全部入っていればOK
  return keywords.every(keyword =>
    user.includes(keyword)
  );
}


// ------------------------------------------------------
// 最終判定
// ------------------------------------------------------
function matchesReturnWord(userText, rawWord) {
  const {
    word,
    reading
  } = splitWordAndReading(rawWord);

  const normalizedWord = normalizeMatchText(word);

  if (!normalizedWord) {
    return false;
  }

// ------------------------------------------------------
// 読み仮名付き
// → 基本的に造語として扱う
// ------------------------------------------------------
if (reading) {
  if (fuzzyShortWordMatch(userText, word)) {
    return true;
  }

  if (fuzzyShortWordMatch(userText, reading)) {
    return true;
  }

  return false;
}

// ------------------------------------------------------
// 短くても文章らしい表現なら文章型判定
//
// 例:
// 次へ進む
// 金運を選ぶ
// 幸せになる
// ------------------------------------------------------
if (isPhraseLike(word)) {
  return phraseMatch(
    userText,
    word
  );
}

// ------------------------------------------------------
// 短い文字列
// → 造語として曖昧一致
// ------------------------------------------------------
if ([...normalizedWord].length <= 6) {
  return fuzzyShortWordMatch(
    userText,
    word
  );
}

// ------------------------------------------------------
// 長い文字列
// → 通常文章として判定
// ------------------------------------------------------
return phraseMatch(
  userText,
  word
);
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

// ho履歴フォールバック用: 表示中の履歴（analyzeMessages()のallKanteishiComments）に
// sinko/hisコメントが見つからない場合、mg_k_rireki.php（履歴100件ページ）を開いて再検索する。
// ope_mainフレーム内の a[href*="mg_k_rireki.php"]（「別ウィンドウで見る」リンク）を
// クリックし、target="_blank"で開く新しいページを取得する。
// 鑑定士メッセージは td[style*="90EE90"; text-align: right;"] に日時等が入り、
// その直後（DOM順で最初）に続くp要素のinnerHTMLにメッセージ本文とコメントアウトが
// &lt;!--...--&gt;形式で入っているため、デコードして抽出する。
// charaIdが指定されている場合、フェーズ違いのsinko/hisコメント（例: mu2/sinko）を
// 拾わないよう、そのcharaIdに一致するコメントのみに絞り込む。
async function searchSinkoFromRirekiHistory(page, charaId) {
  const mainFrame = page.frame({ name: 'ope_main' });
  if (!mainFrame) {
    console.log('[RIREKI] ope_mainフレームが取得できません');
    return null;
  }

  if (await mainFrame.locator('a[href*="mg_k_rireki.php"]').count() === 0) {
    console.log('[RIREKI] mg_k_rireki.phpへのリンクが見つかりません');
    return null;
  }

  let rirekiPage;
  try {
    [rirekiPage] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 10000 }),
      mainFrame.click('a[href*="mg_k_rireki.php"]'),
    ]);
    await rirekiPage.waitForLoadState('load');
  } catch (e) {
    console.log(`[RIREKI] 履歴ページを開けませんでした: ${e.message}`);
    return null;
  }

  let comments = [];
  try {
    const evalResult = await rirekiPage.evaluate(() => {
      // elの後、DOM順で最初に現れるp要素を探す（兄弟になければ親の兄弟へと辿る）
      function findNextP(el) {
        let node = el;
        while (node) {
          let sibling = node.nextElementSibling;
          while (sibling) {
            if (sibling.tagName === 'P') return sibling;
            const nested = sibling.querySelector && sibling.querySelector('p');
            if (nested) return nested;
            sibling = sibling.nextElementSibling;
          }
          node = node.parentElement;
        }
        return null;
      }

      const found = [];
      const greenTds = Array.from(document.querySelectorAll('td[style*="90EE90"]'));
      for (const td of greenTds) {
        const p = findNextP(td);
        if (!p) continue;
        const raw = p.innerHTML || p.textContent || '';
        const decoded = raw
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&');
        const cre = /<!--([^>]+)-->/g;
        let cm;
        while ((cm = cre.exec(decoded)) !== null) found.push(cm[1]);
      }
      return { comments: found };
    });
    comments = evalResult.comments;
  } catch (e) {
    console.log(`[RIREKI] コメント抽出に失敗: ${e.message}`);
  } finally {
    await rirekiPage.close().catch(() => {});
  }

  console.log(`[RIREKI] 再検索コメント件数: ${comments.length} ${JSON.stringify(comments.slice(0, 10))}`);

  // charaIdが指定されている場合は、そのcharaIdに一致するコメントのみを検索する
  // （フェーズ違いのsinko/his、例: mu2/sinkoの誤検出を防ぐ）
  const sinkoComments = comments.filter(c => {
    if (charaId && !c.startsWith(charaId + '/')) return false;
    return /(?:sinko|his\w*)\/?(\d+)/.test(c);
  });
  if (sinkoComments.length === 0) {
    console.log('[RIREKI] sinko/hisコメントは見つかりませんでした');
    return null;
  }

  const nums = sinkoComments
    .map(c => { const m = c.match(/(?:sinko|his\w*)\/?(\d+)/); return m ? parseInt(m[1], 10) : null; })
    .filter(n => n !== null);
  const maxSinko = Math.max(...nums);
  const latestComment = sinkoComments.find(c => {
    const m = c.match(/(?:sinko|his\w*)\/?(\d+)/);
    return m && parseInt(m[1], 10) === maxSinko;
  }) || sinkoComments[0];

  let resolvedCharaId = charaId;
  if (!resolvedCharaId) {
    for (const c of sinkoComments) {
      const m = c.match(/^(\d+(?:yu|mu)\d+\w*)\//);
      if (m) { resolvedCharaId = m[1]; break; }
    }
  }

  return { comments, sinkoComments, maxSinko, latestComment, charaId: resolvedCharaId };
}

// ─── 返信処理メインループ ─────────────────────────────────────────

async function processUsers(
  page,
  targetKids = [],
  autoMode = false,
  maxSendPerRun = 50
) {
  // 今回の実行分だけを記録するため、開始時にリセットする
  skippedUsers = [];
  let autoSendCount = 0;
  let dangerCount = 0;
  let errorCount = 0;
  // 対象外一覧ファイルも新しい返信チェック開始時に上書きリセットする
  resetSkippedList();

  // page = mg_ope.php（親フレームページ）
  // ope_menuフレームから対象ユーザーを取得
let targets = await getTargetUsers(page);

console.log(`[LIST] 抽出ユーザー: ${targets.length}件`);

// ======================================================
// kid指定フィルター
// targetKidsが空なら全kid対象
// ======================================================
if (Array.isArray(targetKids) && targetKids.length > 0) {
  const targetKidSet = new Set(
    targetKids.map(v => String(v).trim())
  );

  targets = targets.filter(user =>
    targetKidSet.has(String(user.kid))
  );

  console.log(
    `[LIST] kidフィルター適用: ${[...targetKidSet].join(', ')}`
  );
}

console.log(`[LIST] 実処理対象ユーザー: ${targets.length}件`);

  if (targets.length === 0) {
    await sendLine('未返信の対象ユーザーはいませんでした');
    return;
  }

  for (const { userName, kid, uid, stringID } of targets) {
    if (_shouldStop) {
      console.log('[STOP] 停止要求により中断');
      break;
    }

    // 返信対象外となった理由を記録する（ログ出力は各判定箇所の[SKIP]をそのまま使う）
    const recordSkip = (reason) => skippedUsers.push({ userName, uid, kid, reason });

    // 1ユーザーの処理中に想定外エラーが発生しても返信チェック全体を止めず、
    // エラーになったユーザーも対象外として記録して次のユーザーへ進む
    try {
    // ─── キャラ別停止時間チェック ──────────────────────────────────
    if (process.env.DISABLE_STOP_TIME !== 'true' && isInStopTime(kid)) {
      console.log(`[SKIP] ${userName}: 停止時間帯のためスキップ (k_id=${kid})`);
      recordSkip(`停止時間帯のためスキップ (k_id=${kid})`);
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
      recordSkip(analysis.reason);
      continue;
    }

    // ─── 受信時刻チェック（20分以内はスキップ）────────────────────
    const receivedAt = parseMessageTime(analysis.latestUserTime || '');
    if (receivedAt) {
      const elapsedMin = (new Date().getTime() - receivedAt.getTime()) / 60000;
      const bypassWaitForAutoTest =
        autoMode &&
        String(kid) === '12541';

      if (elapsedMin < 15 && !bypassWaitForAutoTest) {
        console.log(
          `[TIMER] ${userName}: 受信から${elapsedMin.toFixed(1)}分 → 15分未満のためスキップ`
        );

        recordSkip('15分未満のためスキップ');
        continue;
      }

      if (elapsedMin < 15 && bypassWaitForAutoTest) {
        console.log(
          `[AUTO-TEST] ${userName}: kid=12541 のため15分待機をバイパス`
        );
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
          recordSkip(`span個数(${spanCount}) < ユーザーメッセージ通数(${userMsgCount})-${minOffset}`);
          continue;
        }
      } else if (userMsgCount < spanCount) {
        console.log(`[SKIP] ${userName}: ユーザーメッセージ通数(${userMsgCount}) < span個数(${spanCount})`);
        recordSkip(`ユーザーメッセージ通数(${userMsgCount}) < span個数(${spanCount})`);
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
    // ======================================================
    // 自動巡回限定：ユーザー返信内容の安全判定
    // ======================================================
    if (autoMode) {
      // 最新のユーザーメッセージ1通だけを取得
      const latestUserText =
        bodyNaibuTexts.length > 0
          ? bodyNaibuTexts[0]
          : (analysis.latestUserTexts?.[0] || '');

      // 表示文字として判定するため、HTMLタグ・空白・改行を除去
      const normalizedUserText = String(latestUserText)
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, '')
        .trim();

      console.log(
        `[AUTO-CHECK] ${userName}: 最新ユーザー本文="${normalizedUserText.slice(0, 80)}" ` +
        `文字数=${normalizedUserText.length}`
      );

      // --------------------------------------------------
      // 15文字以上なら自動返信対象外
      // --------------------------------------------------
      if (normalizedUserText.length >= 15) {
        console.log(
          `[AUTO-CHECK] ${userName}: ユーザー本文が15文字以上 → 対象外`
        );

        recordSkip(
          `自動返信対象外: ユーザーメッセージが15文字以上 (${normalizedUserText.length}文字)`
        );

        continue;
      }

      // --------------------------------------------------
      // 送り返す言葉が取得できた場合、
      // 最新ユーザー本文との部分一致を確認
      // --------------------------------------------------
      if (nengenWords.length > 0) {
        const sendWordMatched = nengenWords.some(word =>
          matchesReturnWord(
            normalizedUserText,
            word
          )
        );

        if (!sendWordMatched) {
          console.log(
            `[AUTO-CHECK] ${userName}: 送り返す言葉が最新ユーザー本文に不一致 ` +
            `words=${JSON.stringify(nengenWords)}`
          );

          recordSkip(
            `自動返信対象外: 送り返す言葉がユーザーメッセージに不一致`
          );

          continue;
        }

        console.log(
          `[AUTO-CHECK] ${userName}: 送り返す言葉の部分一致を確認`
        );
      }
    }

      if (nengenWords.length > 0) {
        const userTexts = bodyNaibuTexts.length > 0 ? bodyNaibuTexts : (analysis.latestUserTexts || []);
        const allUserText = userTexts.join('');
        const nengenKeywords = nengenWords.flatMap(extractNengenKeywords);
        const nengenFound = nengenKeywords.some(kw => allUserText.includes(kw));
        console.log(`[NENGEN] ${userName}: 念言=${JSON.stringify(nengenWords)} 検索ワード=${JSON.stringify(nengenKeywords)} 含有=${nengenFound}`);
        // スキップはせず、対象コメントアウト・返信文が判明した後にLINEへ確認通知を送る
        // （processUsers内の【返信確認】送信箇所を参照）
        analysis.nengenNotFound = !nengenFound;
        analysis.nengenWords = nengenWords;
        analysis.nengenUserTexts = userTexts;
        if (!nengenFound) {
          console.log(`[NENGEN] ${userName}: 念言がユーザーメッセージに未発見 → スキップせずLINE確認へ`);
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
        analysis.nengenNotFound = false;
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
        recordSkip('/mtm コメントあり（/his なし）');
        continue;
      }
      console.log(`[INFO] ${userName}: /mtm と /his が共存 → スキップしない`);
    }

    // ho系コメントの検出（数値サフィックス・接頭辞付きも含む: ho1, sinkoHo, noresHo, hiruHo1等）
    const hoComments = allComments.filter(c => /\/[a-zA-Z]*[Hh]o\d*(?:\/\w+)*$/.test(c));
    const hasHo = hoComments.length > 0;

    // /sinko も /his も /ho も subAction も含まれない → スキップ
    if (!hasSubAction && !hasHo && !allComments.some(c => c.includes('/sinko') || c.includes('/his'))) {
      console.log(`[SKIP] ${userName}: /sinko・/his・/ho・subActionコメントなし`);
      recordSkip('/sinko・/his・/ho・subActionコメントなし');
      continue;
    }

    let charaId = null;
    let replyData;
    let latestComment = null;
    let alwaysQuoteUser = true;
    // 履歴にsinko/hisコメントが見つからず sinko/1 から開始したかどうか
    // （LINE確認通知の「対象コメントアウト」行に注記を付けるために保持する）
    let historyNotFound = false;

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
        if (phaseCfg?.alwaysQuoteUser) alwaysQuoteUser = true;
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
              recordSkip(`エラー: ${e.message.slice(0, 50)}`);
              skipUser = true;
            }
            break;
          }
          console.log(`[SKIP] ${userName}: subAction actionCfgなし (${parsed.actionKey})`);
          recordSkip(`subAction actionCfgなし (${parsed.actionKey})`);
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
            recordSkip(`requiredMessages 未達 (${matchCount}/${required})`);
            skipUser = true;
            break;
          }
        }

        // actionCfg自身にfileIdがあれば、phase共通のfileIdより優先する
        // （同一phase内の特定actionだけ別CSVを参照させたいケース用）
        const fileId = actionCfg.fileId ?? phaseCfg.fileId ?? null;

        // timeBasedSearchが設定されている場合（hisuMtm等でbranchと併用）、
        // まず時間帯に応じたfileIdを取得してからbranch/searchTargetを実行する。
        // timeBasedSearch内の各時間帯にfileIdがある場合はphaseCfg.fileIdより優先する。
        let effectiveFileId = fileId;
        if (actionCfg.timeBasedSearch) {
          const now = new Date();
          const curMin = now.getHours() * 60 + now.getMinutes();
          for (const [cKey, cVal] of Object.entries(actionCfg.timeBasedSearch)) {
            const bm = cKey.match(/^before(\d{3,4})$/);
            const am = cKey.match(/^after(\d{3,4})$/);
            if (bm) {
              const t = bm[1].padStart(4, '0');
              const tMin = parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(2), 10);
              if (curMin < tMin && cVal.fileId) { effectiveFileId = cVal.fileId; break; }
            } else if (am) {
              const t = am[1].padStart(4, '0');
              const tMin = parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(2), 10);
              if (curMin >= tMin && cVal.fileId) { effectiveFileId = cVal.fileId; break; }
            }
          }
        }
        console.log(`[JSON] subAction charaId="${parsed.charaId}" fileId="${fileId}" effectiveFileId="${effectiveFileId}" actionKey="${parsed.actionKey}"`);

        // specialProcessがある場合はbranch/searchTargetの前に実行
        if (actionCfg.specialProcess) {
          console.log(`[JSON] subAction specialProcess: ${JSON.stringify(actionCfg.specialProcess)}`);
          await executeSpecialProcess(actionCfg.specialProcess, page, uid, analysis, DRY_RUN, bodyNaibuTexts);
        }

        if (actionCfg.searchTarget) {
          const useCurrentRow = actionCfg.useCurrentRow === true;
          console.log(`[JSON] subAction searchTarget="${actionCfg.searchTarget}" useCurrentRow=${useCurrentRow}`);
          try {
            replyData = getReplyFromCSVByTarget(parsed.charaId, actionCfg.searchTarget, useCurrentRow, effectiveFileId);
          } catch (e) {
            console.error(`[ERROR] subAction searchTarget CSV取得失敗 (${userName}): ${e.message} | charaId=${parsed.charaId} fileId=${effectiveFileId} target=${actionCfg.searchTarget}`);
            recordSkip(`エラー: ${e.message.slice(0, 50)}`);
            skipUser = true;
          }
        }

        // branch設定がある場合: A/B判定してCSV取得（searchTargetがない場合も対応）
        if (!replyData && !skipUser && actionCfg.branch) {
          const latestText = bodyNaibuTexts.length > 0 ? bodyNaibuTexts[0] : (analysis.latestUserTexts?.[0] || '');
          console.log(`[BRANCH] 判定対象テキスト: "${latestText.slice(0, 60)}"`);
          const branchChoice = detectBranchChoice([latestText]);
          const branchTarget = branchChoice === 'A' ? actionCfg.branch.positive : actionCfg.branch.negative;
          console.log(`[JSON] subAction branch自動判定: ${branchChoice} → ${branchTarget} (charaId=${parsed.charaId} fileId=${effectiveFileId})`);
          try {
            replyData = getReplyFromCSVByTarget(parsed.charaId, branchTarget, true, effectiveFileId);
          } catch (e) {
            console.error(`[ERROR] subAction branch CSV取得失敗 (${userName}): ${e.message} | charaId=${parsed.charaId} fileId=${effectiveFileId} target=${branchTarget}`);
            recordSkip(`エラー: ${e.message.slice(0, 50)}`);
            skipUser = true;
          }
        }

        // useHistorySearch: 履歴から最新sinko/hisコメントを検索し、その次行を
        // 送信する（hoのフォールバック処理=historySinkoComments と同じロジック）
        if (!replyData && !skipUser && actionCfg.useHistorySearch) {
          const historyComments = analysis.allKanteishiComments || [];
          console.log(`[DEBUG] useHistorySearch historyComments:`, JSON.stringify(historyComments));
          // フェーズ違いのsinko/hisコメントを拾わないよう、現在のcharaIdに一致するもののみ検索する
          const historySinkoComments = historyComments.filter(c => {
            if (!c.startsWith(parsed.charaId + '/')) return false;
            return /(?:sinko|his\w*)\/?(\d+)/.test(c);
          });

          if (historySinkoComments.length === 0) {
            console.log(`[SKIP] ${userName}: subAction useHistorySearch・履歴にsinko/hisコメントなし (${parsed.actionKey})`);
            recordSkip(`subAction useHistorySearch・履歴にsinko/hisコメントなし (${parsed.actionKey})`);
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
              recordSkip(`エラー: ${e.message.slice(0, 50)}`);
              skipUser = true;
            }
          }
        }

        if (replyData) break;
      }

      if (skipUser || !replyData) {
        if (!skipUser) {
          console.log(`[SKIP] ${userName}: subAction replyData取得失敗`);
          recordSkip('subAction replyData取得失敗');
        }
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
      // 例: "12680mu2/ho/1"      → baseId=12680, typeNum=mu2,      hoType=ho1（スラッシュ区切り形式）
      const hoMatch = hoComment.match(/^(\d+)((?:yu|mu)\d+\w*)\/(?:sinko\/)?(\w+)(?:\/\w+)*$/);

      let hoBaseId = null;
      let hoTypeNum = null;
      let hoType = null;
      if (hoMatch) {
        hoBaseId  = hoMatch[1];
        hoTypeNum = hoMatch[2];
        hoType    = hoMatch[3];
        charaId   = hoBaseId + hoTypeNum;

        // "ho/1"のようにho種別と数字がスラッシュで区切られている場合、
        // JSON側のho1・ho2等の数字付きキーに一致するよう数字を結合する
        // （"ho1"のような数字直結形式は既にhoMatch[3]で捕捉済みのため対象外）
        if (!/\d$/.test(hoType)) {
          const numSuffixMatch = hoComment.match(/\/(\d+)$/);
          if (numSuffixMatch) {
            hoType = hoType + numSuffixMatch[1];
          }
        }
      }

      // JSON設定の読み込みとphase解決
      const hoCharaCfg   = hoBaseId ? loadCharaConfig(hoBaseId) : null;
      const hoPhaseResult = (hoCharaCfg && hoTypeNum) ? resolveHoPhase(hoCharaCfg, hoTypeNum, hoType) : null;
      let hoPhaseCfg   = hoPhaseResult?.cfg ?? null;
      if (isPhaseBlocked(hoPhaseCfg)) {
        console.log(`[TIME] ${userName}: hoPhase "${hoPhaseResult?.key}" 時間帯制限 → フォールバックへ`);
        hoPhaseCfg = null;
      }
      if (hoPhaseCfg?.alwaysQuoteUser) alwaysQuoteUser = true;

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

      // hoFileIdはactionCfg自身のfileIdのみを使う（phaseCfg.fileIdは使わない）。
      // minPhaseNumberでphase設定を流用している場合、phaseCfg.fileIdは
      // 流用元（例: yu5）のCSVを指しているため、それをそのままsearchTarget系の
      // 検索に使うと実際のcharaId（例: yu8）のCSVが検索されなくなる
      const hoFileId = hoActionCfg?.fileId ?? null;

      console.log(`[COMMENT] ${userName}: /hoモード comment="${hoComment}" hoType="${hoType}" phase=${hoPhaseResult?.key} actionCfg=${JSON.stringify(hoActionCfg)}`);

      // 「/sinko/ho」形式の場合はJSONのsearchTarget等を無視し、根底ルール
      // （resolveCsvPath→履歴からsinko検索→sinko+1）で処理する
      const isSinkoHo = /\/sinko\/ho/.test(hoComment);
      if (isSinkoHo) {
        console.log(`[JSON] ho "/sinko/ho"形式 → JSON設定を無視して根底ルール（履歴検索）を適用`);
      }

      // ─── JSON設定に基づく処理分岐 ────────────────────────────────
      if (hoActionCfg && !isSinkoHo) {
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
            recordSkip(`エラー: ${e.message.slice(0, 50)}`);
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
          const selectedFileId = selected.fileId ?? hoFileId;
          console.log(`[JSON] ho timeBasedSearch → "${selected.searchTarget}" useCurrentRow=${useCurrentRow} fileId=${selectedFileId}`);
          try {
            replyData = getReplyFromCSVByTarget(charaId, selected.searchTarget, useCurrentRow, selectedFileId);
          } catch (e) {
            console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
            recordSkip(`エラー: ${e.message.slice(0, 50)}`);
            continue;
          }
        } else if (hoActionCfg.searchTarget) {
          const useCurrentRow = hoActionCfg.useCurrentRow === true;
          console.log(`[JSON] ho searchTarget="${hoActionCfg.searchTarget}" useCurrentRow=${useCurrentRow}`);
          try {
            replyData = getReplyFromCSVByTarget(charaId, hoActionCfg.searchTarget, useCurrentRow, hoFileId);
          } catch (e) {
            console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
            recordSkip(`エラー: ${e.message.slice(0, 50)}`);
            continue;
          }
        } else if (hoActionCfg.nextTarget) {
          console.log(`[JSON] ho nextTarget="${hoActionCfg.nextTarget}"`);
          try {
            replyData = getReplyFromCSVByTarget(charaId, hoActionCfg.nextTarget, true, hoFileId);
          } catch (e) {
            console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
            recordSkip(`エラー: ${e.message.slice(0, 50)}`);
            continue;
          }
        } else if (hoActionCfg.useCurrentRow) {
          // searchTarget系の指定がなくuseCurrentRowのみの場合:
          // hoコメント自身の行（文頭）を取得する
          let currentRowData;
          try {
            currentRowData = getReplyFromCSVByTarget(charaId, hoComment, true, hoFileId);
          } catch (e) {
            console.error(`[ERROR] ho useCurrentRow CSV取得失敗 (${userName}): ${e.message}`);
            recordSkip(`エラー: ${e.message.slice(0, 50)}`);
            continue;
          }
          if (!currentRowData) {
            console.log(`[SKIP] ${userName}: ho useCurrentRow 対象行が見つかりません`);
            recordSkip('ho useCurrentRow 対象行が見つかりません');
            continue;
          }

          if (hoActionCfg.workflowMarker && hoActionCfg.useHistorySearch) {
            // 履歴の最新sinko/hisの次行を取得し、workflowMarker以降を
            // 工程部分として抽出、文頭テキストと結合する
            const historyComments = analysis.allKanteishiComments || [];
            // フェーズ違いのsinko/hisコメントを拾わないよう、現在のcharaIdに一致するもののみ検索する
            const historySinkoComments = historyComments.filter(c => {
              if (!c.startsWith(charaId + '/')) return false;
              return /(?:sinko|his\w*)\/?(\d+)/.test(c);
            });
            if (historySinkoComments.length === 0) {
              console.log(`[SKIP] ${userName}: ho workflowMarker・履歴にsinko/hisコメントなし`);
              recordSkip('ho workflowMarker・履歴にsinko/hisコメントなし');
              continue;
            }
            const histSinkoNums = historySinkoComments
              .map(c => { const m = c.match(/(?:sinko|his\w*)\/?(\d+)/); return m ? parseInt(m[1], 10) : null; })
              .filter(n => n !== null);
            const maxSinko = Math.max(...histSinkoNums);

            let historyNextData;
            try {
              historyNextData = getReplyFromCSV(charaId, maxSinko, hoFileId);
            } catch (e) {
              console.error(`[ERROR] ho workflowMarker 履歴次行取得失敗 (${userName}): ${e.message}`);
              recordSkip(`エラー: ${e.message.slice(0, 50)}`);
              continue;
            }
            if (!historyNextData) {
              console.log(`[SKIP] ${userName}: ho workflowMarker・履歴次行が取得できません`);
              recordSkip('ho workflowMarker・履歴次行が取得できません');
              continue;
            }

            const markerIdx = historyNextData.replyText.indexOf(hoActionCfg.workflowMarker);
            const workflowPart = markerIdx >= 0
              ? historyNextData.replyText.slice(markerIdx)
              : historyNextData.replyText;
            console.log(`[JSON] ho workflowMarker="${hoActionCfg.workflowMarker}" マッチ位置=${markerIdx}`);

            replyData = {
              title: currentRowData.title,
              replyText: currentRowData.replyText + '\n\n' + workflowPart,
              nextComment: historyNextData.nextComment,
            };
          } else {
            // workflowMarker未設定 → 通常のho処理（同行テキストのみ送信）
            replyData = currentRowData;
          }
        }
        // useHistorySearch: true 単体（useCurrentRow指定なし）等はフォールバックに委ねる
      }

      // ─── フォールバック: JSON設定なし or searchTarget系なし ──────
      // 【根底ルール】JSON側にsearchTarget等の明示的な上書き設定がない
      // 場合（STEP1）は、fileId・minPhaseNumber・useHistorySearch・
      // fallback等のJSON設定には一切依存せず以下の3ステップで処理する:
      //   STEP2: resolveCsvPath(charaId) で一番近い既存CSVファイルを解決し
      //          resolvedCharaIdを得る（例: 12676yu7 → 12676yu5）
      //   STEP3: resolvedCharaIdのsinko/hisコメントを履歴から検索する
      //          （表示中の履歴になければmg_k_rireki.phpで100件から再検索）
      //   STEP4: 見つかれば最新sinko+1を送信、見つからなければ
      //          ・JSONにfallback.searchTargetがあればそのコメントアウトを
      //            CSVから検索して取得（useCurrentRowで同行/次行を選択）
      //          ・なければ従来通り resolvedCharaId/sinko/1 を送信する
      if (!replyData) {
        if (!charaId) {
          console.log(`[SKIP] ${userName}: /hoあり・charaIdを特定できません`);
          recordSkip('/hoあり・charaIdを特定できません');
          continue;
        }

        // STEP2
        // phaseCfg（ho phase設定）にfileIdがあればそれを優先してCSVを解決する
        const hoRootFileId = hoPhaseCfg?.fileId ?? null;
        const { resolvedCharaId } = resolveCsvPath(charaId, hoRootFileId);
        // 履歴検索・sinko/1 fallback用のcharaId。
        // fileId指定時はresolvedCharaIdがfileId自体（例: 12677yu3sinko）になり
        // 履歴検索が「12677yu3sinko/sinko/○」になってしまうため、
        // fileId末尾のsinko/hisを除去したbaseCharaId（例: 12677yu3）を検索キーに使う。
        const searchCharaId = hoRootFileId
          ? hoRootFileId.replace(/sinko$|his$/, '') // 末尾のsinko/hisを除去
          : resolvedCharaId;
        console.log(`[JSON] ho 根底ルール: charaId=${charaId} fileId=${hoRootFileId} → resolvedCharaId=${resolvedCharaId} searchCharaId=${searchCharaId}`);

        // STEP3
        const historyComments = analysis.allKanteishiComments || [];
        let historySinkoComments = historyComments.filter(c => {
          if (!c.startsWith(searchCharaId + '/')) return false;
          return /(?:sinko|his\w*)\/?(\d+)/.test(c);
        });
        console.log(`[DEBUG] searchCharaId=${searchCharaId} のsinko/hisコメント件数(表示中履歴): ${historySinkoComments.length}`);

        if (historySinkoComments.length === 0) {
          // 表示中の履歴にsinko/hisコメントが見つからない場合、
          // mg_k_rireki.php（履歴100件ページ）を開いて再検索する
          console.log(`[JSON] ho: 表示中の履歴に${searchCharaId}のsinko/hisコメントなし → mg_k_rireki.php で再検索`);
          let rirekiResult = null;
          try {
            rirekiResult = await searchSinkoFromRirekiHistory(page, searchCharaId);
          } catch (e) {
            console.error(`[ERROR] ho 履歴再検索失敗 (${userName}): ${e.message}`);
          }
          if (rirekiResult) {
            historySinkoComments = rirekiResult.sinkoComments;
          }
        }

        // STEP4
        if (historySinkoComments.length > 0) {
          const histSinkoNums = historySinkoComments
            .map(c => { const m = c.match(/(?:sinko|his\w*)\/?(\d+)/); return m ? parseInt(m[1], 10) : null; })
            .filter(n => n !== null);
          const maxSinko = Math.max(...histSinkoNums);
          latestComment = historySinkoComments.find(c => {
            const m = c.match(/(?:sinko|his\w*)\/?(\d+)/);
            return m && parseInt(m[1], 10) === maxSinko;
          }) || hoComment;

          console.log(`[COMMENT] ${userName}: /ho 根底ルール sinko+1 searchCharaId=${searchCharaId} fileId=${hoRootFileId} maxSinko=${maxSinko}`);
          try {
            replyData = getReplyFromCSV(searchCharaId, maxSinko, hoRootFileId);
          } catch (e) {
            console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
            recordSkip(`エラー: ${e.message.slice(0, 50)}`);
            continue;
          }
        } else if (hoActionCfg?.fallback?.searchTarget) {
          // 履歴にsinkoが見つからず、JSONのfallback.searchTargetが指定されている
          // 場合は、そのコメントアウトをCSVから検索して取得する
          // （searchTargetの通常処理と同様にcharaId・hoFileIdで解決する）
          const fbCfg = hoActionCfg.fallback;
          const fbUseCurrentRow = fbCfg.useCurrentRow === true;
          const fbFileId = fbCfg.fileId ?? hoFileId;
          console.log(`[COMMENT] ${userName}: /ho 根底ルール 履歴になし → fallback.searchTarget="${fbCfg.searchTarget}" useCurrentRow=${fbUseCurrentRow} fileId=${fbFileId}`);
          historyNotFound = true;
          try {
            replyData = getReplyFromCSVByTarget(charaId, fbCfg.searchTarget, fbUseCurrentRow, fbFileId);
          } catch (e) {
            console.error(`[ERROR] ho 根底ルール fallback.searchTarget取得失敗 (${userName}): ${e.message}`);
            recordSkip(`エラー: ${e.message.slice(0, 50)}`);
            continue;
          }
          latestComment = fbCfg.searchTarget;
        } else {
          console.log(`[COMMENT] ${userName}: /ho 根底ルール 履歴になし → ${searchCharaId}/sinko/1 を送信`);
          historyNotFound = true;
          try {
            replyData = getReplyFromCSVByTarget(searchCharaId, `${searchCharaId}/sinko/1`, true, hoRootFileId);
          } catch (e) {
            console.error(`[ERROR] ho 根底ルール sinko/1取得失敗 (${userName}): ${e.message}`);
            recordSkip(`エラー: ${e.message.slice(0, 50)}`);
            continue;
          }
          latestComment = hoComment;
        }
      }

      // ─── replaceHeader: ho設定があれば返信文の文頭を差し替える ──────
      // （LINE確認通知を送る前に適用する）
      if (replyData && hoActionCfg?.replaceHeader) {
        replyData.replyText = applyReplaceHeader(replyData.replyText, hoActionCfg.replaceHeader);
        console.log(`[JSON] ho replaceHeader適用 (${userName})`);
      }
    } else {
      // 通常の sinko/his 処理（hisu等のhis変形も含む）
      const sinkoComments = allComments.filter(c => /(?:sinko|his\w*)\/?(\d+)/.test(c));

      const sinkoNums = sinkoComments
        .map(c => { const m = c.match(/(?:sinko|his\w*)\/?(\d+)/); return m ? parseInt(m[1], 10) : null; })
        .filter(n => n !== null);

      // charaId を抽出（複合コメント形式にも対応）
      for (const c of sinkoComments) {
        const m = c.match(/^(\d+(?:yu|mu)\d+\w*)\//);
        if (m) { charaId = m[1]; break; }
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
      if (phaseCfg?.alwaysQuoteUser) alwaysQuoteUser = true;
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
          const effectiveFileId = actionCfg?.fileId ?? fileId;
          try {
            replyData = getReplyFromCSVByTarget(charaId, branchTarget, true, effectiveFileId);
          } catch (e) {
            console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
            recordSkip(`エラー: ${e.message.slice(0, 50)}`);
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
          const effectiveFileId = actionCfg?.fileId ?? fileId;
          try {
            replyData = getReplyFromCSVByTarget(charaId, selected.searchTarget, useCurrentRow, effectiveFileId);
          } catch (e) {
            console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
            recordSkip(`エラー: ${e.message.slice(0, 50)}`);
            continue;
          }
        } else if (actionCfg.searchTarget) {
          const useCurrentRow = actionCfg.useCurrentRow === true;
          console.log(`[JSON] searchTarget="${actionCfg.searchTarget}" useCurrentRow=${useCurrentRow}`);
          const effectiveFileId = actionCfg?.fileId ?? fileId;
          try {
            replyData = getReplyFromCSVByTarget(charaId, actionCfg.searchTarget, useCurrentRow, effectiveFileId);
          } catch (e) {
            console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
            recordSkip(`エラー: ${e.message.slice(0, 50)}`);
            continue;
          }
        } else if (actionCfg.nextTarget) {
          console.log(`[JSON] nextTarget="${actionCfg.nextTarget}"`);
          const effectiveFileId = actionCfg?.fileId ?? fileId;
          try {
            replyData = getReplyFromCSVByTarget(charaId, actionCfg.nextTarget, true, effectiveFileId);
          } catch (e) {
            console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
            recordSkip(`エラー: ${e.message.slice(0, 50)}`);
            continue;
          }
        } else if (actionCfg.checkPattern) {
          // checkPattern判定（例: sinko1）: ユーザーの最新メッセージがcheckPatternに一致し
          // maxLength以下なら短縮返信(shortReply)を使用。それ以外は通常の次行処理へフォールバック。
          const rawMsg = bodyNaibuTexts.length > 0 ? bodyNaibuTexts[0] : (analysis.latestUserTexts?.[0] || '');
          const cleanMsg = rawMsg.replace(/[\t\n\r]/g, '').replace(/\s+/g, ' ').trim();
          const patternRe = new RegExp(actionCfg.checkPattern);
          const matched = patternRe.test(cleanMsg);
          const withinLen = cleanMsg.length <= (actionCfg.maxLength ?? Infinity);
          console.log(`[JSON] checkPattern="${actionCfg.checkPattern}" matched=${matched} len=${cleanMsg.length}/${actionCfg.maxLength ?? '∞'} within=${withinLen}`);
          if (matched && withinLen && actionCfg.shortReply) {
            // shortReply内にコメントアウトが含まれる前提のため、nextCommentは空にする
            replyData = { title: 'checkPattern-short', replyText: actionCfg.shortReply, nextComment: '' };
            alwaysQuoteUser = true;
            console.log(`[JSON] checkPattern一致かつmaxLength以下 → shortReplyを使用`);
          } else {
            // 未一致、またはmaxLength超過 → replyData未設定のまま通常の次行(sinko+1)処理へ
            console.log(`[JSON] checkPattern不一致 or 長文 → 通常の次行処理へフォールバック`);
          }
        } else if (actionCfg.useHistorySearch) {
          // useHistorySearch: この sinko アクション設定がある場合のみ、phase由来のcharaIdではなく
          // resolveCsvPath で直近の既存sinkoファイルを解決し、履歴からsinko検索→sinko+1を取得する。
          // （actionCfgにuseHistorySearchが無い場合は本分岐に入らず従来処理を継続するため、
          //   他のphase・キャラIDには影響しない）
          //
          // historyCharaId が指定されている場合は、現在のcharaIdではなく
          // そのcharaId（例: "12673yu3"）で履歴を検索し、
          // resolveCsvPath(historyCharaId) で解決したCSVからsinko+1を取得する。
          // 履歴に見つからない場合は fallbackSearch のコメントアウト行
          // （その行自身）を送信する。
          const historyCharaId = actionCfg.historyCharaId || null;
          const { resolvedCharaId } = resolveCsvPath(historyCharaId || charaId);
          // 履歴検索に使うcharaId（historyCharaId指定時はそのIDで検索する）
          const searchCharaId = historyCharaId || resolvedCharaId;
          if (historyCharaId) {
            console.log(`[JSON] sinko useHistorySearch: historyCharaId="${historyCharaId}" で履歴検索`);
          }
          console.log(`[JSON] sinko useHistorySearch: charaId=${charaId} → searchCharaId=${searchCharaId} resolvedCharaId=${resolvedCharaId}`);

          const historyComments = analysis.allKanteishiComments || [];
          let historySinkoComments = historyComments.filter(c => {
            if (!c.startsWith(searchCharaId + '/')) return false;
            return /(?:sinko|his\w*)\/?(\d+)/.test(c);
          });
          console.log(`[DEBUG] searchCharaId=${searchCharaId} のsinko/hisコメント件数(表示中履歴): ${historySinkoComments.length}`);

          if (historySinkoComments.length === 0) {
            console.log(`[JSON] sinko useHistorySearch: 表示中の履歴に${searchCharaId}のsinko/hisコメントなし → mg_k_rireki.php で再検索`);
            let rirekiResult = null;
            try {
              rirekiResult = await searchSinkoFromRirekiHistory(page, searchCharaId);
            } catch (e) {
              console.error(`[ERROR] sinko useHistorySearch 履歴再検索失敗 (${userName}): ${e.message}`);
            }
            if (rirekiResult) historySinkoComments = rirekiResult.sinkoComments;
          }

          if (historySinkoComments.length > 0) {
            const histSinkoNums = historySinkoComments
              .map(c => { const m = c.match(/(?:sinko|his\w*)\/?(\d+)/); return m ? parseInt(m[1], 10) : null; })
              .filter(n => n !== null);
            const maxSinko = Math.max(...histSinkoNums);
            latestComment = historySinkoComments.find(c => {
              const m = c.match(/(?:sinko|his\w*)\/?(\d+)/);
              return m && parseInt(m[1], 10) === maxSinko;
            }) || latestComment;
            console.log(`[COMMENT] ${userName}: sinko useHistorySearch sinko+1 resolvedCharaId=${resolvedCharaId} maxSinko=${maxSinko}`);
            try {
              replyData = getReplyFromCSV(resolvedCharaId, maxSinko);
            } catch (e) {
              console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
              continue;
            }
          } else {
            // fallbackSearch 未指定時は従来どおり {resolvedCharaId}/sinko/1 を送信する
            const fallbackTarget = actionCfg.fallbackSearch || `${resolvedCharaId}/sinko/1`;
            console.log(`[COMMENT] ${userName}: sinko useHistorySearch 履歴になし → ${fallbackTarget} を送信`);
            historyNotFound = true;
            try {
              replyData = getReplyFromCSVByTarget(resolvedCharaId, fallbackTarget, true);
            } catch (e) {
              console.error(`[ERROR] sinko useHistorySearch フォールバック取得失敗 (${userName}): ${e.message}`);
              recordSkip(`エラー: ${e.message.slice(0, 50)}`);
              continue;
            }
          }

          // 取得した文章の文頭をreplaceHeaderで差し替え
          if (replyData && actionCfg.replaceHeader) {
            replyData.replyText = applyReplaceHeader(replyData.replyText, actionCfg.replaceHeader);
            console.log(`[JSON] sinko useHistorySearch replaceHeader適用 (${userName})`);
          }
        }
        // specialProcessのみなど、searchTarget系設定がない場合はデフォルト動作へ
      }

      // ─── searchOverride チェック ─────────────────────────────────
      // sinko/3/A 等で parseCommentStr=null → phaseCfg=null でも解決できるよう
      // charaId から typeNum を抽出してフォールバック解決する
      if (!replyData && latestComment && charaCfg) {
        const ovPhase = phaseCfg ?? (() => {
          const tn = charaId?.match(/(?:yu|mu)\d+\w*/)?.[0];
          return tn ? (charaCfg.phases?.[tn] ?? null) : null;
        })();
        const ovFileId = fileId ?? ovPhase?.fileId ?? null;

        if (ovPhase?.searchOverride) {
          const overrideCfg = ovPhase.searchOverride[latestComment];
          if (overrideCfg?.timeBasedSearch) {
            // 時間帯に応じてfileId/searchTargetを選択
            const now = new Date();
            const curMin = now.getHours() * 60 + now.getMinutes();
            let selected = null;
            for (const [cKey, cVal] of Object.entries(overrideCfg.timeBasedSearch)) {
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
              console.log(`[JSON] searchOverride timeBasedSearch: 一致する時間帯なし → スキップ`);
              continue;
            }
            if (selected.searchTarget) {
              const useCurrentRow = selected.useCurrentRow === true;
              const selectedFileId = selected.fileId ?? ovFileId;
              console.log(`[JSON] searchOverride timeBasedSearch: "${latestComment}" → searchTarget="${selected.searchTarget}" useCurrentRow=${useCurrentRow} fileId=${selectedFileId}`);
              try {
                replyData = getReplyFromCSVByTarget(charaId, selected.searchTarget, useCurrentRow, selectedFileId);
              } catch (e) {
                console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
                continue;
              }
            }
          } else if (overrideCfg?.searchTarget) {
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
            recordSkip(`エラー: ${e.message.slice(0, 50)}`);
            continue;
          }
        } else {
          console.log(`[COMMENT] ${userName}: sinko+1検索モード maxSinko=${maxSinkoNum}`);
          try {
            replyData = getReplyFromCSV(charaId, maxSinkoNum, fileId);
          } catch (e) {
            console.error(`[ERROR] CSV取得失敗 (${userName}): ${e.message}`);
            recordSkip(`エラー: ${e.message.slice(0, 50)}`);
            continue;
          }
        }
      }
    }

    if (!replyData) {
      await sendLine(`【終了】${userName}の返信文章が終了しました`);
      continue;
    }

    // ======================================================
    // 危険文章チェック
    // ======================================================
    const safetyResult = checkReplySafety(replyData.replyText);

    if (!safetyResult.safe) {
      const ignoreComments = loadReplySafetyIgnoreComments();

      const currentComments = [
        ...(Array.isArray(allComments) ? allComments : []),
        replyData.nextComment || ''
      ]
        .map(v => String(v || '').replace(/^<!--|-->$/g, '').trim())
        .filter(Boolean);

      const ignoredComment = currentComments.find(comment =>
        ignoreComments.has(comment)
      );

      if (ignoredComment) {
        console.log(
          `[REPLY-SAFETY] ${userName}: 危険候補だが除外登録済み → 続行 (${ignoredComment})`
        );
      } else {
        const reasonText = safetyResult.reasons.join(' / ');

        console.log(
          `[REPLY-SAFETY] ${userName}: 危険文章を検出 → 対象外 (${reasonText})`
        );
        dangerCount++;
        recordSkip(
          `危険文章: ${reasonText}`
        );

        continue;
      }
    }

    // ─── LINEに確認メッセージを送信 ─────────────────────────────
    // \n（リテラル）が残っている場合に備えて実際の改行に変換してから表示
    const displayReplyText = replyData.replyText.replace(/\\n/g, '\n');
    // ユーザーメッセージ引用の見出し（受信日時があれば併記）
    const userMsgLabel = analysis.latestUserTime
      ? `ユーザーメッセージ（${analysis.latestUserTime}受信）：`
      : 'ユーザーメッセージ：';
    // ─── コメントアウト表示行 ────────────────────────────────────
    // 最新コメントアウト：最新の鑑定士メッセージに含まれるコメントアウト
    // 対象コメントアウト：今回の返信取得に使用したコメントアウト
    //   履歴にsinko/hisが見つからずsinko/1から開始した場合は末尾に注記を付ける
    const latestKanteishiLine =
      `最新コメントアウト：${(analysis.kanteishiComments || []).join('、') || '（なし）'}`;
    const targetCommentLine = latestComment
      ? `対象コメントアウト：${latestComment}${historyNotFound ? '（※履歴なし→sinko/1から開始）' : ''}`
      : '対象コメントアウト：（なし）';
    const lineMsg = analysis.hasLongMessage
      ? [
          '【長文メッセージあり】',
          `ユーザー：${userName}（u_id: ${uid}）`,
          latestKanteishiLine,
          targetCommentLine,
          '',
          userMsgLabel,
          '---',
          (analysis.longMessageTexts || []).join('\n'),
          '---',
          '返信文：',
          '---',
          displayReplyText,
          replyData.nextComment,
          '---',
          '送信する場合は「送信」',
          'スキップする場合は「スキップ」と返信してください',
        ].join('\n')
      : analysis.nengenNotFound
      ? [
          '【念言未検出】',
          `ユーザー：${userName}（u_id: ${uid}）`,
          latestKanteishiLine,
          targetCommentLine,
          `念言：${(analysis.nengenWords || []).join('、')}`,
          '',
          userMsgLabel,
          '---',
          (analysis.nengenUserTexts || []).join('\n'),
          '---',
          '返信文：',
          '---',
          displayReplyText,
          replyData.nextComment,
          '---',
          '「送信」：そのまま送信',
          '「スキップ」：スキップ',
          '「差し込み#{文章}」：2行目の後に挿入して確認',
          '「差し替え#{文章}」：返信文を差し替えて確認',
        ].join('\n')
      : [
          '【返信確認】',
          `ユーザー：${userName}（u_id: ${uid}）`,
          latestKanteishiLine,
          targetCommentLine,
          ...(alwaysQuoteUser ? [
            userMsgLabel,
            '---',
            buildQuoteText(bodyNaibuTexts, analysis),
            '---',
          ] : analysis.hasConsultation ? [
            userMsgLabel,
            '---',
            (analysis.consultationTexts || []).join('\n'),
            '---',
          ] : []),
          '返信文：',
          '---',
          displayReplyText,
          replyData.nextComment,
          '---',
          '「送信」：そのまま送信',
          '「スキップ」：スキップ',
          '「差し込み#{文章}」：2行目の後に挿入して確認',
          '「差し替え#{文章}」：返信文を差し替えて確認',
        ].join('\n');
        if (!autoMode) {
          await sendLine(lineMsg);
        }

        // ope_mainフレーム内のフォームに記入して送信する共通処理
    async function sendReplyText(textToSend) {
      console.log(`[SEND-TEXT] 送信内容: "${textToSend.slice(0, 80)}..."`);
      if (DRY_RUN) {
        console.log(`[DRY RUN] 送信をスキップ: ${userName}`);
        await sendLine(`【DRY RUN】${userName}への返信送信をスキップしました`);
        return;
      }
      const sendFrame = page.frame({ name: 'ope_main' });
      if (!sendFrame) {
        console.log(`[WARN] ${userName}: 送信時にope_mainフレームが取得できません`);
        return;
      }
      await sendFrame.fill('textarea#mess_body', textToSend);
      await sendFrame.click('#chara_mail_send');
      await sendFrame.waitForLoadState('networkidle').catch(() => {});
      console.log(`[SEND] ${userName} 送信完了`);
      await sendLine(`【送信完了】${uid}へ${kid}からの返信を送信しました`);
    }

    // ======================================================
    // 自動返信モード
    // ======================================================
    if (autoMode) {
      if (autoSendCount >= maxSendPerRun) {
        const message = [
          '【自動返信を安全停止しました】',
          '',
          `最大送信件数：${maxSendPerRun}件`,
          `今回送信済み：${autoSendCount}件`,
          '',
          '送信件数が設定上限に到達したため、',
          '今回の自動巡回を停止しました。'
        ].join('\n');

        console.error(
          `[AUTO-REPLY] 最大送信件数 ${maxSendPerRun}件に到達`
        );

        await sendLine(message);

        throw new Error('AUTO_REPLY_SEND_LIMIT');
      }

      const textToSend =
        replyData.replyText
          .replace(/\\n/g, '\n')
          .trim()
        + '\n'
        + (replyData.nextComment || '');

      console.log(
        `[AUTO-REPLY] ${userName} (u_id=${uid}, k_id=${kid}) を自動送信します`
      );

      await sendReplyText(textToSend);

      autoSendCount++;

      continue;
    }


    // ─── LINE返信を待つ（5分タイムアウト → スキップ）────────────
    let reply;
    try {
      reply = await waitForLineReply();
    } catch (e) {
      console.log(`[TIMEOUT] ${userName}: 5分タイムアウト → スキップ`);
      recordSkip('LINE確認の5分タイムアウト');
      continue;
    }

    console.log(`[LINE] 返信: ${reply}`);


    // 「差し込み#{文章}」「差し替え#{文章}」形式の返信を検出
    const isSashikomi = reply.startsWith('差し込み#');
    const isSashikae  = reply.startsWith('差し替え#');

    // ─── 送信 / スキップ / 差し込み / 差し替え ────────────────────
    if (reply === '送信') {
      // 返信文 + 次のコメントアウトを末尾に追記（先頭・末尾の余分な改行を除去）
      const textToSend = replyData.replyText.replace(/\\n/g, '\n').trim() + '\n' + replyData.nextComment;
      await sendReplyText(textToSend);
    } else if (isSashikomi) {
      // 返信文の1行目と2行目の間に差し込み文を挿入した全文を生成
      // 「テンプレート{番号}」の場合はcharaId対応のテンプレート本文に置換する
      let insertText = reply.replace(/^差し込み#/, '').trim();
      insertText = resolveTemplateText(charaId, insertText).replace(/\\n/g, '\n');
      const baseLines = replyData.replyText.replace(/\\n/g, '\n').trim().split('\n');
      const splicedLines = [baseLines[0], insertText, ...baseLines.slice(1)];
      const splicedText = splicedLines.join('\n') + '\n' + replyData.nextComment;

      const confirmMsg = [
        '【差し込み確認】',
        '---',
        splicedText,
        '---',
        'この内容で送信しますか？',
        '「送信」または「スキップ」',
      ].join('\n');
      await sendLine(confirmMsg);

      let sashikomiReply;
      try {
        sashikomiReply = await waitForLineReply();
      } catch (e) {
        console.log(`[TIMEOUT] ${userName}: 差し込み確認 5分タイムアウト → スキップ`);
        recordSkip('差し込み確認の5分タイムアウト');
        continue;
      }
      console.log(`[LINE] 差し込み確認返信: ${sashikomiReply}`);

      if (sashikomiReply === '送信') {
        await sendReplyText(splicedText);
      } else {
        console.log(`[SKIP] ${userName} 差し込みをスキップ`);
        recordSkip('差し込み確認でスキップを選択');
      }
    } else if (isSashikae) {
      // #以降のテキストを新しい返信文として丸ごと差し替える
      // 差し替え文章にはコメントアウトが含まれる前提のため、元のnextCommentは付加しない
      // 「テンプレート{番号}」の場合はcharaId対応のテンプレート本文に置換する
      let replacedText = reply.replace(/^差し替え#/, '').trim();
      replacedText = resolveTemplateText(charaId, replacedText).replace(/\\n/g, '\n');

      // 差し替え文章にコメントアウト（<!--...-->）が含まれていない場合は、
      // 最新のコメントアウトを自動で文末に付与する。
      // 通常の差し替え・テンプレート呼び出しのどちらもここを通るため両方に適用される。
      const hasCommentTag = /<!--.*-->/.test(replacedText);
      if (!hasCommentTag && latestComment) {
        const commentTag = latestComment.startsWith('<!--')
          ? latestComment
          : `<!--${latestComment}-->`;
        replacedText = `${replacedText}\n${commentTag}`;
        console.log(`[SASHIKAE] コメントアウトなし → 最新コメントアウトを付与: ${commentTag}`);
      }

      const replacedFullText = replacedText;

      const confirmMsg = [
        '【差し替え確認】',
        '---',
        replacedText,
        '---',
        'この内容で送信しますか？',
        '「送信」または「スキップ」',
      ].join('\n');
      await sendLine(confirmMsg);

      let sashikaeReply;
      try {
        sashikaeReply = await waitForLineReply();
      } catch (e) {
        console.log(`[TIMEOUT] ${userName}: 差し替え確認 5分タイムアウト → スキップ`);
        recordSkip('差し替え確認の5分タイムアウト');
        continue;
      }
      console.log(`[LINE] 差し替え確認返信: ${sashikaeReply}`);

      if (sashikaeReply === '送信') {
        await sendReplyText(replacedFullText);
      } else {
        console.log(`[SKIP] ${userName} 差し替えをスキップ`);
        recordSkip('差し替え確認でスキップを選択');
      }
    } else {
      console.log(`[SKIP] ${userName} スキップ`);
      recordSkip('LINEでスキップを選択');
    }
    } catch (e) {
      errorCount++;
      console.error(`[ERROR] ${userName}: 処理中にエラーが発生しました: ${e.message}`, e.stack);
      skippedUsers.push({
        userName,
        uid,
        kid,
        reason: `エラー: ${e.message.slice(0, 50)}`,
      });
      continue;
    }
  }
  return {
    sentCount: autoSendCount,
    skippedCount: skippedUsers.length,
    dangerCount,
    errorCount
  };
}

// ─── ope_mainフレームから最新の鑑定士コメントアウトを取得する ──────────
// analyzeMessages と同じDOM走査（緑背景 #90EE90 が鑑定士メッセージ）で、
// DOM最上位＝最新の鑑定士メッセージの本文からコメントアウト（<!--...-->）を
// 抽出して返す。target判定に依存せず、返信済み等の対象外ユーザーでも取得できる。
// 複数コメントがある場合は ", " で結合。鑑定士メッセージ/コメントが無ければ ''。
async function getLatestKanteishiComment(page) {
  const mainFrame = page.frame({ name: 'ope_main' });
  if (!mainFrame) return '';
  return await mainFrame.evaluate(() => {
    function normStyle(el) {
      return (el.getAttribute('style') || '').replace(/\s/g, '').toLowerCase();
    }
    for (const trEl of document.querySelectorAll('tr')) {
      const trBg = normStyle(trEl);
      const tdBg = Array.from(trEl.querySelectorAll('td')).map(td => normStyle(td)).join('');
      const bg = trBg + tdBg;
      if (!(bg.includes('90ee90') || bg.includes('144,238,144'))) continue;

      // 最新（DOM最上位）の鑑定士メッセージを発見 → 本文を取得
      const bodyInput = trEl.querySelector('input[type="hidden"][id^="body_"]');
      let bodyText;
      if (bodyInput) {
        bodyText = bodyInput.value;
      } else {
        const bodyNaibuEl = trEl.querySelector('div.bodyNaibu');
        bodyText = bodyNaibuEl ? (bodyNaibuEl.textContent || '') : '';
      }
      const decodedBody = bodyText
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .replace(/\x3C/g, '<').replace(/\x3E/g, '>');
      const comments = [];
      const cre = /<!--([^>]+)-->/g;
      let cm;
      while ((cm = cre.exec(decodedBody)) !== null) comments.push(cm[1].trim());
      return comments.length > 0 ? comments.join(', ') : '';
    }
    return ''; // 鑑定士メッセージなし
  });
}

// 最新コメントアウトから「次のコメントアウト」を計算する。
// sinko/N または his/N の番号Nを+1する（例:「12686yu1/sinko/2」→「12686yu1/sinko/3」）。
// 番号が見つからない場合はそのまま返す。
function computeNextComment(comment) {
  if (!comment) return comment;
  const m = comment.match(/((?:sinko|his\w*)\/?)(\d+)/);
  if (!m) return comment;
  const next = parseInt(m[2], 10) + 1;
  return comment.replace(/((?:sinko|his\w*)\/?)(\d+)/, `$1${next}`);
}

// ─── 対象外ユーザーの会話をope_mainに表示するまでの共通処理 ─────────────
// 「対象外ID:{番号} ...」系コマンド（手動返信・本文照会）で共有する。
//   対象外一覧ファイルから番号→uid/kidを解決 → ログイン → サポート画面 →
//   対象ユーザー一覧からuid・kid一致行を特定 → ope_menuのformをsubmitして
//   ope_mainに会話を表示 → fn({ supportPage, target, uid, kid, userName }) を呼ぶ
// ブラウザの起動/終了はここで行い、fnの中で会話操作・通知を行う。
// sendLine は呼び出し側（server.js）から渡す。
async function withSkippedTargetConversation(index, sendLine, fn) {
  if (!index) {
    await sendLine('【エラー】対象外返信: 番号が指定されていません');
    return;
  }

  // 対象外一覧ファイル（番号付き）から番号→uid/kidを解決する
  let entry = null;
  try {
    const list = JSON.parse(fs.readFileSync(SKIPPED_LIST_FILE, 'utf8'));
    if (Array.isArray(list)) entry = list.find(e => String(e.index) === String(index));
  } catch (e) {
    console.log(`[MANUAL-REPLY] 対象外一覧ファイルの読み込みに失敗: ${e.message}`);
  }
  if (!entry) {
    await sendLine(
      `【エラー】対象外返信\n対象外ID：${index} が一覧に見つかりませんでした\n` +
      '（返信チェック未実施か、番号が範囲外の可能性があります）'
    );
    return;
  }
  const uid = String(entry.uid);
  const kid = String(entry.kid);
  console.log(`[MANUAL-REPLY] 対象外ID=${index} → uid=${uid} kid=${kid} userName=${entry.userName}`);

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

    // 対象ユーザー一覧から uid・kid の両方が一致する行を特定する
    const targets = await getTargetUsers(supportPage);
    const target = targets.find(t => String(t.uid) === uid && String(t.kid) === kid);
    if (!target) {
      console.log(`[MANUAL-REPLY] 対象外ID=${index}: uid=${uid} kid=${kid} が対象ユーザー一覧に見つかりません`);
      await sendLine(
        `【エラー】対象外返信\n対象外ID：${index}（u_id: ${uid}, k_id: ${kid}）が対象ユーザー一覧に見つかりませんでした\n` +
        '（既に対応済みか、一覧から外れた可能性があります）'
      );
      return;
    }
    const { userName, stringID } = target;
    console.log(`[MANUAL-REPLY] 対象特定: ${userName} (k_id=${kid}, u_id=${uid}, stringID=${stringID})`);

    const menuFrame = supportPage.frame({ name: 'ope_menu' });
    const mainFrame = supportPage.frame({ name: 'ope_main' });
    if (!menuFrame || !mainFrame) {
      await sendLine(`【エラー】対象外返信\n会員ID：${uid} のフレーム取得に失敗しました`);
      return;
    }

    // submit前に#bodyKakuninを空にして前候補の内容の誤検知を防ぐ
    await mainFrame.evaluate(() => {
      const el = document.querySelector('#bodyKakunin');
      if (el) el.innerHTML = '';
    });

    // ope_menuフレームでformをsubmit → Ajaxでope_mainに会話を表示
    await menuFrame.evaluate((sid) => {
      const form = document.getElementById(sid);
      if (!form) throw new Error(`id="${sid}" のformが見つかりません`);
      form.submit();
    }, stringID);

    await new Promise(r => setTimeout(r, 500));
    try {
      await mainFrame.waitForFunction(() => {
        const el = document.querySelector('#bodyKakunin');
        const trCount = document.querySelectorAll('tr').length;
        return el !== null && el.innerHTML.length > 0 && trCount >= 20;
      }, { timeout: 15000 });
    } catch (_) {
      console.log(`[MANUAL-REPLY] ${userName}: #bodyKakunin のタイムアウト（続行）`);
    }

    await fn({ supportPage, target, uid, kid, userName });
  } catch (err) {
    console.error(`[MANUAL-REPLY] 対象外ID=${index}: 処理に失敗: ${err.message}`, err.stack);
    await sendLine(`【エラー】対象外返信に失敗しました\n対象外ID：${index}\nエラー：${err.message}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── 対象外ユーザーへの手動返信 ─────────────────────────────────────
// LINE/Slackコマンド「対象外ID:{番号} {返信文章}」から呼び出す。
// 返信チェックで対象外となったユーザーへ、指定した返信文章を確認のうえ送信する。
//   最新の鑑定士コメントアウトを取得 → 付与するコメントアウトを決定 →
//   LINE/Slackへ確認通知 → 返信待ち → 「送信」の場合のみ
//   ope_mainフレームの textarea#mess_body に入力して #chara_mail_send で送信
// useNextComment:
//   false（デフォルト）… 最終コメントアウトと同一のものを文末に付与
//   true                … 次のコメントアウト（番号+1）を文末に付与
// sendLine / waitForLineReply は呼び出し側（server.js）から渡す
async function sendManualReply(index, replyText, sendLine, waitForLineReply, DRY_RUN = false, useNextComment = false) {
  console.log(`[MANUAL-REPLY] 対象外ID=${index} useNextComment=${useNextComment} 返信文="${(replyText || '').slice(0, 40)}"`);

  // 前回の停止要求が残っていると waitForLineReply が即座に停止扱いになるため、
  // 確認の返信待ちを行う前に停止フラグをリセットする
  _shouldStop = false;

  if (!replyText) {
    await sendLine('【エラー】対象外返信: 返信文章が指定されていません');
    return;
  }

  await withSkippedTargetConversation(index, sendLine, async ({ supportPage, uid, kid, userName }) => {
    // ── 「テンプレート{番号}」指定ならテンプレート本文に置換する ──────────
    // 対象会員のkid（例: "12676yu5"）のbaseId（"12676"）に対応する
    // reply-templates/{baseId}.json から該当IDのtextを取得して返信文章に使う。
    // 通常の手入力文章・テンプレート未発見時はそのまま元の文章を使う。
    let effectiveReplyText = replyText;
    if (/^テンプレート\d+$/.test(replyText.trim())) {
      effectiveReplyText = resolveTemplateText(kid, replyText.trim()).replace(/\\n/g, '\n');
      console.log(`[MANUAL-REPLY] uid=${uid} kid=${kid} テンプレート指定 → "${effectiveReplyText.slice(0, 40)}"`);
    }

    // ── 最新の鑑定士コメントアウトを取得 ───────────────────────────
    const latestComment = await getLatestKanteishiComment(supportPage);
    console.log(`[MANUAL-REPLY] uid=${uid} 最新コメントアウト: "${latestComment}"`);

    // 付与するコメントアウトを決定する。
    // ・useNextComment=false（デフォルト）: 最終コメントアウトと同一
    // ・useNextComment=true: 次のコメントアウト（番号+1）
    const commentToAppend = useNextComment ? computeNextComment(latestComment) : latestComment;

    // 返信文の末尾にコメントアウトを付与したものを確認通知・実送信の両方で使う。
    // プレーンテキスト（例:「12686yu1/sinko/2」）はコメントアウト形式に整える。
    let finalReplyText = effectiveReplyText;
    if (commentToAppend) {
      const commentTag = commentToAppend.startsWith('<!--')
        ? commentToAppend
        : `<!--${commentToAppend}-->`;
      finalReplyText = `${effectiveReplyText}\n${commentTag}`;
    }

    // ── LINE/Slackへ確認通知して返信を待つ ─────────────────────────
    await sendLine([
      '【対象外返信確認】',
      `会員ID：${uid}`,
      `最終コメントアウト：${latestComment || '（なし）'}`,
      `付与コメントアウト：${commentToAppend || '（なし）'}${useNextComment ? '（次行）' : '（同一）'}`,
      '返信内容：',
      '---',
      finalReplyText,
      '---',
      '「送信」または「スキップ」',
    ].join('\n'));

    let reply;
    try {
      reply = await waitForLineReply();
    } catch (e) {
      console.log(`[MANUAL-REPLY] uid=${uid}: 確認待ちタイムアウト → 中止: ${e.message}`);
      await sendLine(`【対象外返信】会員ID：${uid}\n確認がタイムアウトしたため中止しました`);
      return;
    }
    console.log(`[MANUAL-REPLY] uid=${uid} 確認返信: ${reply}`);

    if (reply !== '送信') {
      console.log(`[MANUAL-REPLY] uid=${uid}: 「送信」以外 → スキップ`);
      await sendLine(`【対象外返信】会員ID：${uid}\nスキップしました`);
      return;
    }

    if (DRY_RUN) {
      console.log(`[DRY RUN] uid=${uid}: 対象外返信の送信をスキップ`);
      await sendLine(`【DRY RUN】対象外返信の送信をスキップしました\n会員ID：${uid}`);
      return;
    }

    // ── 「送信」→ ope_mainフレームのフォームに入力して送信 ───────────
    const sendFrame = supportPage.frame({ name: 'ope_main' });
    if (!sendFrame) {
      await sendLine(`【エラー】対象外返信\n会員ID：${uid} の送信フレーム取得に失敗しました`);
      return;
    }
    await sendFrame.fill('textarea#mess_body', finalReplyText);
    await sendFrame.click('#chara_mail_send');
    await sendFrame.waitForLoadState('networkidle').catch(() => {});
    console.log(`[MANUAL-REPLY] uid=${uid} (${userName}) 送信完了`);

    await sendLine(`【対象外返信完了】\n会員ID：${uid}`);
  });
}

// ─── 対象外ユーザーの本文照会（送信なし）─────────────────────────────
// LINE/Slackコマンド「対象外ID:{番号} 本文照会」から呼び出す。
// 対象ユーザーの最新コメントアウトとユーザーメッセージ（bodyNaibuTexts）を
// 取得してLINE/Slackへ通知するのみで、返信送信は行わない。
async function inquireUserBody(index, sendLine) {
  console.log(`[MANUAL-REPLY] 本文照会 対象外ID=${index}`);

  await withSkippedTargetConversation(index, sendLine, async ({ supportPage, uid }) => {
    const latestComment = await getLatestKanteishiComment(supportPage);

    const mainFrame = supportPage.frame({ name: 'ope_main' });
    let bodyTexts = [];
    if (mainFrame) {
      try {
        bodyTexts = await getBodyNaibuTexts(mainFrame);
      } catch (e) {
        console.log(`[本文照会] uid=${uid}: bodyNaibuTextsの取得に失敗: ${e.message}`);
      }
    }
    const messageBlock = (bodyTexts && bodyTexts.length > 0)
      ? bodyTexts.map(t => decodeHtml(t)).join('\n---\n')
      : '（ユーザーメッセージが取得できませんでした）';

    console.log(`[本文照会] uid=${uid} メッセージ${bodyTexts.length}件 最新コメント="${latestComment}"`);

    await sendLine([
      '【本文照会】',
      `会員ID：${uid}`,
      `最新コメントアウト：${latestComment || '（なし）'}`,
      '',
      'ユーザーメッセージ：',
      '---',
      messageBlock,
      '---',
    ].join('\n'));
  });
}

// ─── 同一コメントアウトグループへの一括送信 ─────────────────────────
// LINE/Slackコマンド「{コメントアウト} 検索」（例:「12686yu1/sinko/1 検索」）から呼び出す。
// 対象ユーザー一覧の中から、最新コメントアウトが指定文字列と完全一致する会員を抽出し、
// 指定コメントアウトの「次の行」の文章（CSV）を一括送信の確認・送信対象とする。
//   1. 送信予定文章をCSVから取得（getReplyFromCSVByTarget / useCurrentRow=false）
//   2. 対象ユーザーを走査し、最新コメントアウトが完全一致する会員を抽出
//      （各会員のユーザーメッセージ bodyNaibuTexts も取得）
//   3. LINE/Slackへ該当一覧＋送信予定文章を通知
//   4. コマンド待ち
//      ・「送信」            → 全員に送信
//      ・「除外:{uid,...} 送信」→ 指定uidを除いて送信
//      ・「スキップ」        → 何もしない
// sendLine / waitForLineReply は呼び出し側（server.js）から渡す。
async function batchSearchAndReply(searchComment, sendLine, waitForLineReply, DRY_RUN = false) {
  console.log(`[BATCH-SEARCH] コメントアウト="${searchComment}"`);

  // 前回の停止要求が残っていると waitForLineReply が即座に停止扱いになるため、
  // 確認の返信待ちを行う前に停止フラグをリセットする（sendManualReplyと同じ）
  _shouldStop = false;

  if (!searchComment) {
    await sendLine('【エラー】一括送信: コメントアウトが指定されていません');
    return;
  }

  // コメントアウトからcharaIdを解析（例:「12684yu12/sinko/1」→「12684yu12」）
  const parsedComment = parseCommentStr(searchComment);
  if (!parsedComment) {
    await sendLine(`【エラー】一括送信: コメントアウトの形式が不正です\n指定値：${searchComment}`);
    return;
  }
  const charaId = parsedComment.baseId + parsedComment.typeNum;

  // ── 送信予定の文章をCSVから取得（指定コメントアウトの「次の行」）──
  // ※コメントアウト文字列ではなく、実際に送信する文章内容を取得する
  let replyData;
  try {
    replyData = getReplyFromCSVByTarget(charaId, searchComment, false);
  } catch (e) {
    await sendLine(`【エラー】一括送信: 送信文章の取得に失敗しました\nコメントアウト：${searchComment}\n${e.message}`);
    return;
  }
  if (!replyData || !replyData.replyText) {
    await sendLine(`【エラー】一括送信: 送信文章が空です\nコメントアウト：${searchComment}`);
    return;
  }
  const displayReplyText = replyData.replyText.replace(/\\n/g, '\n');
  // 実際に送信する全文（返信文 + 次のコメントアウトを末尾に追記）
  const textToSend = replyData.replyText.replace(/\\n/g, '\n').trim() + '\n' + replyData.nextComment;

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    httpCredentials: {
      username: process.env.BASIC_AUTH_ID,
      password: process.env.BASIC_AUTH_PASS,
    },
  });

  // 指定コメントアウトを表示中の会話（ope_main）に反映するまでの共通処理。
  // 対象会員のope_menuフォームをsubmitし、#bodyKakuninの更新を待つ。
  async function showConversation(supportPage, stringID, label) {
    const menuFrame = supportPage.frame({ name: 'ope_menu' });
    const mainFrame = supportPage.frame({ name: 'ope_main' });
    if (!menuFrame || !mainFrame) return null;

    // submit前に#bodyKakuninを空にして前候補の内容の誤検知を防ぐ
    await mainFrame.evaluate(() => {
      const el = document.querySelector('#bodyKakunin');
      if (el) el.innerHTML = '';
    });
    try {
      await menuFrame.evaluate((sid) => {
        const form = document.getElementById(sid);
        if (!form) throw new Error(`id="${sid}" のformが見つかりません`);
        form.submit();
      }, stringID);
    } catch (e) {
      console.log(`[BATCH-SEARCH] ${label}: form.submit()に失敗: ${e.message}`);
      return null;
    }
    await new Promise(r => setTimeout(r, 500));
    try {
      await mainFrame.waitForFunction(() => {
        const el = document.querySelector('#bodyKakunin');
        const trCount = document.querySelectorAll('tr').length;
        return el !== null && el.innerHTML.length > 0 && trCount >= 20;
      }, { timeout: 15000 });
    } catch (_) {
      console.log(`[BATCH-SEARCH] ${label}: #bodyKakunin のタイムアウト（続行）`);
    }
    return mainFrame;
  }

  // getLatestKanteishiComment は複数コメントを ", " で結合して返すため、
  // 分割して searchComment と完全一致するものが含まれるか判定する
  function latestMatches(latestComment) {
    const list = latestComment ? latestComment.split(',').map(s => s.trim()) : [];
    return list.includes(searchComment);
  }

  const matched = []; // { userName, uid, kid, stringID, message }
  try {
    const page = await context.newPage();
    await login(page);
    const supportPage = await openSupportPage(page);

    // ── 1. 対象ユーザーを走査し、最新コメントアウトが完全一致する会員を抽出 ──
    const targets = await getTargetUsers(supportPage);
    console.log(`[BATCH-SEARCH] 対象ユーザー: ${targets.length}件`);

    for (const { userName, kid, uid, stringID } of targets) {
      if (_shouldStop) { console.log('[BATCH-SEARCH] 停止要求により中断'); break; }

      const mainFrame = await showConversation(supportPage, stringID, userName);
      if (!mainFrame) continue;

      const latestComment = await getLatestKanteishiComment(supportPage);
      console.log(`[BATCH-SEARCH] ${userName}(uid=${uid}) 最新コメントアウト="${latestComment}"`);
      if (!latestMatches(latestComment)) continue;

      // ── 2. 会員のユーザーメッセージ（最新の未対応メッセージ）を取得 ──
      let bodyTexts = [];
      try { bodyTexts = await getBodyNaibuTexts(mainFrame); } catch (_) {}
      const message = (bodyTexts && bodyTexts.length > 0)
        ? decodeHtml(bodyTexts[0]).replace(/[\t\n\r]/g, ' ').replace(/\s+/g, ' ').trim()
        : '（メッセージ取得不可）';

      matched.push({ userName, uid, kid, stringID, message });
    }

    if (matched.length === 0) {
      await sendLine(`【一括送信対象】${searchComment}\n該当グループ：0件\n最新コメントアウトが一致する会員は見つかりませんでした`);
      return;
    }

    // ── 3. LINE/Slackへ該当一覧＋送信予定文章を通知 ──
    const listLines = matched.flatMap((m, i) => [
      `${i + 1}. ${m.userName}（u_id: ${m.uid}）`,
      `   メッセージ：${m.message.slice(0, 40)}`,
    ]);
    await sendLine([
      `【一括送信対象】${searchComment}`,
      `該当グループ：${matched.length}件`,
      '',
      ...listLines,
      '',
      '送信予定の文章：',
      '---',
      displayReplyText,
      replyData.nextComment,
      '---',
      '',
      '「送信」：全員に送信',
      '「除外:{uid,uid,...} 送信」：指定uidを除いて送信',
      '「スキップ」：何もしない',
    ].join('\n'));

    // ── 4. コマンド待ち ──
    let reply;
    try {
      reply = await waitForLineReply();
    } catch (e) {
      console.log(`[BATCH-SEARCH] 確認待ちタイムアウト → 中止: ${e.message}`);
      await sendLine(`【一括送信】確認がタイムアウトしたため中止しました\nコメントアウト：${searchComment}`);
      return;
    }
    console.log(`[BATCH-SEARCH] 確認返信: ${reply}`);

    // 「除外:{uid,uid,...} 送信」→ 除外uidを抽出（カンマ・読点・空白区切り）
    let excludeUids = [];
    const excludeMatch = reply.match(/^除外[:：]\s*([\d,、\s]+?)\s*送信$/);
    if (excludeMatch) {
      excludeUids = excludeMatch[1].split(/[,、\s]+/).map(s => s.trim()).filter(Boolean);
    } else if (reply !== '送信') {
      // 「スキップ」やその他 → 何もしない
      console.log(`[BATCH-SEARCH] 「送信」「除外:… 送信」以外 → スキップ`);
      await sendLine(`【一括送信】スキップしました\nコメントアウト：${searchComment}`);
      return;
    }

    const sendTargets = matched.filter(m => !excludeUids.includes(String(m.uid)));
    if (sendTargets.length === 0) {
      await sendLine(`【一括送信】除外の結果、送信対象が0件になりました\nコメントアウト：${searchComment}`);
      return;
    }

    if (DRY_RUN) {
      console.log(`[DRY RUN] 一括送信をスキップ 対象=${sendTargets.length}件`);
      await sendLine(`【DRY RUN】一括送信をスキップしました\nコメントアウト：${searchComment}\n対象：${sendTargets.length}件（除外${excludeUids.length}件）`);
      return;
    }

    // ── 5. 一括送信 ──
    const sentResults = [];
    for (const m of sendTargets) {
      if (_shouldStop) { console.log('[BATCH-SEARCH] 送信中に停止要求により中断'); break; }
      try {
        const mainFrame = await showConversation(supportPage, m.stringID, m.userName);
        if (!mainFrame) { sentResults.push(`${m.uid}（${m.userName}）：フレーム取得失敗`); continue; }

        // 確認通知〜送信までの間に状態が変わっていないか（最新コメントアウトが
        // まだ一致＝未返信のまま）を再確認し、変化していれば誤送信を防ぐためスキップ
        const stillComment = await getLatestKanteishiComment(supportPage);
        if (!latestMatches(stillComment)) {
          console.log(`[BATCH-SEARCH] uid=${m.uid}: 最新コメントアウトが変化("${stillComment}") → スキップ`);
          sentResults.push(`${m.uid}（${m.userName}）：状態変化のためスキップ`);
          continue;
        }

        const sendFrame = supportPage.frame({ name: 'ope_main' });
        if (!sendFrame) { sentResults.push(`${m.uid}（${m.userName}）：送信フレーム取得失敗`); continue; }
        await sendFrame.fill('textarea#mess_body', textToSend);
        await sendFrame.click('#chara_mail_send');
        await sendFrame.waitForLoadState('networkidle').catch(() => {});
        console.log(`[BATCH-SEARCH] uid=${m.uid}（${m.userName}）送信完了`);
        sentResults.push(`${m.uid}（${m.userName}）：送信完了`);
      } catch (e) {
        console.error(`[BATCH-SEARCH] uid=${m.uid} 送信エラー: ${e.message}`);
        sentResults.push(`${m.uid}（${m.userName}）：送信エラー ${e.message.slice(0, 40)}`);
      }
    }

    await sendLine([
      '【一括送信完了】',
      `コメントアウト：${searchComment}`,
      `送信対象：${sendTargets.length}件（除外${excludeUids.length}件）`,
      '',
      ...sentResults.map(r => `・${r}`),
    ].join('\n'));
  } catch (err) {
    console.error(`[BATCH-SEARCH] 処理に失敗: ${err.message}`, err.stack);
    await sendLine(`【エラー】一括送信に失敗しました\nコメントアウト：${searchComment}\nエラー：${err.message}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── エントリポイント ─────────────────────────────────────────────

function stopReplies() {
  _shouldStop = true;
  console.log('=== reply-checker 停止要求 ===');
}

async function checkReplies(options = {}) {
    const {
    autoMode = false,
    targetKids = []
  } = options;

  const normalizedTargetKids = Array.isArray(targetKids)
    ? targetKids.map(v => String(v).trim()).filter(Boolean)
    : [];

  console.log(
    `[REPLY] mode=${autoMode ? 'AUTO' : 'MANUAL'} targetKids=${
      normalizedTargetKids.length
        ? normalizedTargetKids.join(',')
        : 'ALL'
    }`
  );
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
    await loginWithRetry(
      page,
      autoMode
        ? (options.retry?.login ?? 2)
        : 1
    );
    const supportPage = await openSupportPageWithRetry(
      page,
      autoMode
        ? (options.retry?.pageLoad ?? 2)
        : 1
    );
    const result = await processUsers(
      supportPage,
      normalizedTargetKids,
      autoMode,
      options.maxSendPerRun ?? 50
    );

    // 対象外一覧を番号付きでファイルに保存
    saveSkippedList();

    // 自動巡回時は集計通知を先に出す
    if (autoMode) {
      await sendLine(
        [
          '【自動返信チェック完了】',
          '',
          `送信件数：${result?.sentCount ?? 0}件`,
          `対象外件数：${result?.skippedCount ?? 0}件`,
          `危険文章：${result?.dangerCount ?? 0}件`,
          `エラー：${result?.errorCount ?? 0}件`
        ].join('\n')
      );
    }

    // 従来の対象外ID一覧
    await sendLine(buildSkippedMessage());

    console.log('=== reply-checker 完了 ===');
  } catch (err) {
    console.error('[FATAL]', err.message, err.stack);

    // 自動巡回時はserver.js側で安全停止処理を行うため、
    // エラーを上位へ返す
    if (autoMode) {
      throw err;
    }

    // 手動返信チェックは従来どおりここで通知
    await sendLine(
      `【システムエラー】reply-checker: ${err.message}`
    );
  } finally {
    clearState();
    await browser.close();
  }
}

if (require.main === module) {
  checkReplies();
}

module.exports = { checkReplies, stopReplies, sendManualReply, inquireUserBody, batchSearchAndReply, sendLine, waitForLineReply };

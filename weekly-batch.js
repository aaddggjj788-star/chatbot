'use strict';

/**
 * weekly-batch.js
 * 毎週土曜日22時に実行するサポートキャラ統合の自動バッチ処理。
 *
 * 配置場所: /root/rune-bot/weekly-batch.js
 * 実行:      node weekly-batch.js
 *
 * 【処理フロー】
 *   STEP1 ログイン（mg_index.php →「こちら」s_systemリンク → ID/PASS入力）
 *   STEP2 会員検索（受信キャラID・メッセージNo・トリガー発動履歴の期間/文字列を入力して検索）
 *   STEP3 会員ID取得（「名前一括操作」→ mg_change_name.php の idlist を取得）
 *   STEP4 サポートキャラ統合（親12341 / 子12340 に会員IDを流し込み「統合確認」→「統合開始」）
 *   STEP5 LINEへ完了通知
 *
 * 【DRY_RUN】.env の DRY_RUN=true のときは STEP4 の実統合（統合確認/統合開始）は行わず、
 *            対象IDと件数のみをLINE通知する。
 *
 * 【ログ】実行結果を BATCH_LOG_DIR（既定 /root/rune-bot/logs）配下に
 *         weekly-batch-{YYYYMMDD}.log として保存する。
 *
 * 【スケジュール】server.js の PM2 とは別プロセスとして cron で実行する。
 *   crontab -e で以下を追加（毎週土曜22:00・サーバのタイムゾーン基準）:
 *     0 22 * * 6 cd /root/rune-bot && /usr/bin/node weekly-batch.js >> /root/rune-bot/logs/weekly-batch-cron.log 2>&1
 *
 * 【接続情報】すべて .env から読み込む（認証情報はコードに直書きしない）:
 *   BATCH_SYSTEM_URL / BATCH_BASIC_AUTH_ID / BATCH_BASIC_AUTH_PASS /
 *   BATCH_LOGIN_ID / BATCH_LOGIN_PASS / LINE_CHANNEL_ACCESS_TOKEN /
 *   BATCH_LOG_DIR / DRY_RUN
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ─── 設定 ─────────────────────────────────────────────────────────
const SYSTEM_URL     = process.env.BATCH_SYSTEM_URL || 'http://manager.online-777.jp/mg/mg_index.php';
const BASE_URL       = SYSTEM_URL.replace(/[^/]+$/, ''); // 例: http://manager.online-777.jp/mg/
const MEMBER_SEARCH_URL = process.env.BATCH_MEMBER_SEARCH_URL || (BASE_URL + 'mg_kyoseitaikai_list.php');
const CHARA_TOGO_URL    = process.env.BATCH_CHARA_TOGO_URL || (BASE_URL + 'mg_charaTogo.php');
const BASIC_AUTH_ID  = process.env.BATCH_BASIC_AUTH_ID;
const BASIC_AUTH_PASS= process.env.BATCH_BASIC_AUTH_PASS;
const LOGIN_ID       = process.env.BATCH_LOGIN_ID;
const LOGIN_PASS     = process.env.BATCH_LOGIN_PASS;
const LINE_TOKEN     = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DRY_RUN        = process.env.DRY_RUN === 'true';

// 統合対象の設定（案件固定値。必要なら .env で上書き可能）
const RECEIVE_CHARA_ID  = process.env.BATCH_RECEIVE_CHARA_ID  || '12340'; // 受信キャラID / 移行元（子）
const CHARA_MESS_NO_MIN = process.env.BATCH_CHARA_MESS_NO_MIN || '1';
const TRIGGER_HISTORY   = process.env.BATCH_TRIGGER_HISTORY   || '12340yu';
const PARENT_CHARA_ID   = process.env.BATCH_PARENT_CHARA_ID   || '12341'; // 移行先（親 botai）
const CHILD_CHARA_ID    = process.env.BATCH_CHILD_CHARA_ID    || '12340'; // 移行元（子 ko）

// ログ出力先（VPS: /root/rune-bot/logs、無ければ __dirname/logs にフォールバック）
function resolveLogDir() {
  const preferred = process.env.BATCH_LOG_DIR || '/root/rune-bot/logs';
  for (const dir of [preferred, path.join(__dirname, 'logs')]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch (_) { /* 次の候補へ */ }
  }
  return __dirname;
}
const LOG_DIR = resolveLogDir();

// ─── 日付ユーティリティ ───────────────────────────────────────────
function pad2(n) { return String(n).padStart(2, '0'); }

// 指定日数だけ過去の日付を { year, month, day } で返す
function dateBefore(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return { year: String(d.getFullYear()), month: String(d.getMonth() + 1), day: String(d.getDate()) };
}

function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function ymd(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

// ─── ロガー（コンソール + ファイル追記）────────────────────────────
const LOG_FILE = path.join(LOG_DIR, `weekly-batch-${ymd()}.log`);
function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) { /* ログ失敗は握りつぶす */ }
}

// ─── LINE 送信 ────────────────────────────────────────────────────
async function sendLine(message) {
  if (!LINE_TOKEN) { log('[LINE] トークン未設定のため通知スキップ'); return; }
  const MAX_RETRY = 3;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      await axios.post(
        'https://api.line.me/v2/bot/message/broadcast',
        { messages: [{ type: 'text', text: message }] },
        { headers: { Authorization: `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      await new Promise(r => setTimeout(r, 2000)); // 429対策
      return;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < MAX_RETRY) {
        log(`[LINE] 429 → 10秒待ってリトライ (${attempt}/${MAX_RETRY})`);
        await new Promise(r => setTimeout(r, 10000));
      } else {
        log(`[LINE] 送信エラー (attempt ${attempt}): ${err.message}`);
        return;
      }
    }
  }
}

// ─── 汎用ヘルパー ──────────────────────────────────────────────────

// input / select どちらでも値を設定する（select は数値・ゼロ埋め・ラベルの順に試行）
async function setField(scope, selector, value) {
  const loc = scope.locator(selector);
  if (await loc.count() === 0) { log(`  [WARN] フィールド未検出: ${selector}`); return false; }
  const el = loc.first();
  const tag = await el.evaluate(node => node.tagName.toLowerCase()).catch(() => 'input');
  if (tag === 'select') {
    for (const v of [String(value), pad2(value)]) {
      try { await el.selectOption(v); return true; } catch (_) { /* 次を試す */ }
    }
    try { await el.selectOption({ label: String(value) }); return true; } catch (_) { /* fallthrough */ }
    log(`  [WARN] select設定失敗: ${selector}=${value}`);
    return false;
  }
  await el.fill(String(value));
  return true;
}

// リンク／ボタンをテキスト（またはvalue）で探してクリックする
async function clickByText(page, name, { timeout = 15000 } = {}) {
  const strategies = [
    () => page.getByRole('link', { name, exact: false }),
    () => page.getByRole('button', { name, exact: false }),
    () => page.locator(`a:has-text("${name}")`),
    () => page.locator(`button:has-text("${name}")`),
    () => page.locator(`input[type="submit"][value*="${name}"]`),
    () => page.locator(`input[type="button"][value*="${name}"]`),
    () => page.locator(`input[type="image"][alt*="${name}"]`),
  ];
  for (const build of strategies) {
    const loc = build();
    if (await loc.count() > 0) {
      await loc.first().click({ timeout });
      return true;
    }
  }
  return false;
}

// ─── STEP1: ログイン ──────────────────────────────────────────────
async function login(page) {
  log('STEP1: ログイン開始');
  await page.goto(SYSTEM_URL, { waitUntil: 'networkidle' });
  log(`  タイトル: ${await page.title()}`);

  // 「こちら」= s_system リンク（index.php?s_system=...）
  const sessionLink = page.locator('a[href*="s_system"]');
  if (await sessionLink.count() > 0) {
    log('  s_systemリンク（こちら）をクリック');
    await sessionLink.first().click();
    await page.waitForLoadState('networkidle');
  } else {
    log('  [WARN] s_systemリンクが見つかりません（既にログインフォームの可能性）');
  }

  // ログインフォーム（mg系共通: name="id" / name="pass" / name="login"）
  await setField(page, '[name="id"]', LOGIN_ID);
  await setField(page, '[name="pass"]', LOGIN_PASS);
  if (!(await clickByText(page, 'ログイン'))) {
    await page.click('[name="login"]').catch(() => {});
  }
  await page.waitForLoadState('networkidle');
  log(`  ログイン完了: ${await page.title()}`);
  return page.url();
}

// 左メニューのphpリンク（target="main"でiframe内の可能性あり）を開く汎用ヘルパー。
// href直クリック→フレーム内探索→URL直接オープンの順で試し、
// verifySelector がトップレベルに現れるまで担保する。
//   phpFile:        リンクのhref（例: 'mg_charaTogo.php'）
//   verifySelector: 遷移先で存在すべき要素（例: '#ReceiveCharaID'）
//   directUrl:      フォールバックで開くURL
//   label:          ログ表示名
async function openMainPage(page, phpFile, verifySelector, directUrl, label) {
  const hrefSel = `a[href*="${phpFile}"]`;

  // 1. ページ直下のリンクを探す
  let clicked = false;
  if (await page.locator(hrefSel).count() > 0) {
    log(`  ${label}リンク（href）をクリック`);
    await page.locator(hrefSel).first().click().catch(() => {});
    clicked = true;
  } else {
    // 2. iframe（target="main"等）内のリンクを探す
    for (const frame of page.frames()) {
      if (await frame.locator(hrefSel).count() > 0) {
        log(`  ${label}リンク（フレーム内）をクリック`);
        await frame.locator(hrefSel).first().click().catch(() => {});
        clicked = true;
        break;
      }
    }
  }
  if (clicked) await page.waitForLoadState('networkidle').catch(() => {});

  // 3. 対象フォームがトップレベルに出ていなければURLを直接開く
  //    （リンク未検出、または target="main" でiframe内に開いた場合のフォールバック）
  if (await page.locator(verifySelector).count() === 0) {
    log(`  ${label}フォーム未検出 → URL直接オープン: ${directUrl}`);
    await page.goto(directUrl, { waitUntil: 'networkidle' });
  }

  if (await page.locator(verifySelector).count() === 0) {
    throw new Error(`${label}ページを開けません（${directUrl}）`);
  }
}

// 会員検索ページを開く
// 実HTML: <a href="mg_kyoseitaikai_list.php" target="main" onclick="Nowplace('.23')">会員検索</a>
async function openMemberSearch(page) {
  await openMainPage(page, 'mg_kyoseitaikai_list.php', '#ReceiveCharaID', MEMBER_SEARCH_URL, '会員検索');
}

// ─── STEP2: 会員検索 ──────────────────────────────────────────────
async function memberSearch(page) {
  log('STEP2: 会員検索開始');
  await openMemberSearch(page);

  await setField(page, '#ReceiveCharaID', RECEIVE_CHARA_ID);
  await setField(page, '#charaMessNoMin', CHARA_MESS_NO_MIN);

  // トリガー発動履歴 期間: 始点=7日前 / 終点=6日前
  const start = dateBefore(7);
  const end   = dateBefore(6);
  log(`  期間: ${start.year}/${start.month}/${start.day} 〜 ${end.year}/${end.month}/${end.day}`);
  await setField(page, '[name="in_year[1002]"]',  start.year);
  await setField(page, '[name="in_month[1002]"]', start.month);
  await setField(page, '[name="in_day[1002]"]',   start.day);
  await setField(page, '[name="in_year[1003]"]',  end.year);
  await setField(page, '[name="in_month[1003]"]', end.month);
  await setField(page, '[name="in_day[1003]"]',   end.day);

  await setField(page, '[name="triggerhistory"]', TRIGGER_HISTORY);

  if (!(await clickByText(page, 'ユーザー検索'))) {
    throw new Error('「ユーザー検索」ボタンが見つかりません');
  }
  await page.waitForLoadState('networkidle');
  log('  検索完了');
}

// ─── STEP3: 会員ID取得 ────────────────────────────────────────────
async function fetchIdList(page) {
  log('STEP3: 会員ID取得開始');
  if (!(await clickByText(page, '名前一括操作'))) {
    throw new Error('「名前一括操作」ボタンが見つかりません');
  }
  await page.waitForLoadState('networkidle');
  log(`  遷移先: ${page.url()}`);

  const idlistLoc = page.locator('textarea[name="idlist"]');
  if (await idlistLoc.count() === 0) {
    throw new Error('textarea[name="idlist"] が見つかりません（対象0件の可能性）');
  }
  // idlist は「ID番号,」のカンマ区切り形式。カンマで分割し数字のみを抽出する。
  const rawText = (await idlistLoc.first().inputValue()) || '';
  const ids = rawText.split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s));
  log(`  取得ID件数: ${ids.length}`);

  // ブラウザバックでメインページへ戻る
  await page.goBack({ waitUntil: 'networkidle' }).catch(() => {});
  return { rawText, ids };
}

// ─── STEP4: サポートキャラ統合 ────────────────────────────────────
async function integrate(page, idData) {
  log('STEP4: サポートキャラ統合開始');
  // 予期しない confirm ダイアログは自動承認
  page.on('dialog', d => d.accept().catch(() => {}));

  // 実HTML: <a href="mg_charaTogo.php" target="main" onclick="Nowplace('.45')">サポートキャラ統合</a>
  // href直クリック→フレーム内探索→URL直接オープンの順で開く
  await openMainPage(page, 'mg_charaTogo.php', '[name="botai"]', CHARA_TOGO_URL, 'サポートキャラ統合');

  await setField(page, '[name="botai"]', PARENT_CHARA_ID);
  await setField(page, '[name="ko"]', CHILD_CHARA_ID);
  await setField(page, 'textarea[name="uid"]', idData.rawText);

  if (DRY_RUN) {
    log('  [DRY RUN] 統合確認/統合開始はスキップ（実統合は行わない）');
    return;
  }

  if (!(await clickByText(page, '統合確認'))) {
    throw new Error('「統合確認」ボタンが見つかりません');
  }
  await page.waitForLoadState('networkidle');

  if (!(await clickByText(page, '統合開始'))) {
    throw new Error('確認画面「統合開始」ボタンが見つかりません');
  }
  await page.waitForLoadState('networkidle');
  log('  統合開始を実行しました');
}

// ─── STEP5: 完了通知 ──────────────────────────────────────────────
function buildNotification(idData, executedAt) {
  const idBlock = idData.ids.length > 0 ? idData.ids.join('\n') : '（なし）';
  const header = DRY_RUN ? '【サポートキャラ統合（DRY RUN）】' : '【サポートキャラ統合完了】';
  return [
    header,
    `実行日時：${executedAt}`,
    `移行元キャラID：${CHILD_CHARA_ID}`,
    `移行先キャラID：${PARENT_CHARA_ID}`,
    '対象会員ID：',
    idBlock,
    `件数：${idData.ids.length}件`,
  ].join('\n');
}

// ─── メイン ───────────────────────────────────────────────────────
async function runWeeklyBatch() {
  const executedAt = stamp();
  log('=== weekly-batch 起動 ===');
  if (DRY_RUN) log('[DRY RUN] モード有効');

  if (!BASIC_AUTH_ID || !BASIC_AUTH_PASS || !LOGIN_ID || !LOGIN_PASS) {
    const msg = 'BATCH_BASIC_AUTH_ID / BATCH_BASIC_AUTH_PASS / BATCH_LOGIN_ID / BATCH_LOGIN_PASS が未設定です（.envを確認）';
    log(`[FATAL] ${msg}`);
    await sendLine(`【サポートキャラ統合エラー】\n${msg}`);
    process.exitCode = 1;
    return;
  }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    httpCredentials: { username: BASIC_AUTH_ID, password: BASIC_AUTH_PASS },
  });

  try {
    const page = await context.newPage();
    await login(page);
    await memberSearch(page);
    const idData = await fetchIdList(page);
    await integrate(page, idData);

    const notification = buildNotification(idData, executedAt);
    await sendLine(notification);
    log(`STEP5: LINE通知送信（${idData.ids.length}件）`);
    log('=== weekly-batch 完了 ===');
  } catch (err) {
    log(`[FATAL] ${err.message}\n${err.stack || ''}`);
    await sendLine(`【サポートキャラ統合エラー】\n実行日時：${executedAt}\n${err.message}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  runWeeklyBatch();
}

module.exports = { runWeeklyBatch };

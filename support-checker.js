'use strict';

/**
 * support-checker.js
 * サポート画面（#ffffe0）のユーザーのお知らせメールを取得し、
 * キャンペーン内容を解析して購入金額に応じたポイント付与額を算出する検証スクリプト
 *
 * 配置場所: /root/rune-bot/support-checker.js
 * 実行: node support-checker.js  または  server.js から checkSupport() を呼ぶ
 *
 * 【処理フロー】
 *   1. ログイン（reply-checker.js と同じログイン処理）
 *   2. サポート画面（mg_ope.php）を開く
 *   3. ope_menuフレーム内から#ffffe0の行を検出し、ユーザー名欄をクリック
 *      → ope_mainフレーム内 div.bodyNaibu の最新ユーザーメッセージを確認し、
 *        ポイント関連の問い合わせでなければ次の#ffffe0行へスキップ
 *   4. ope_mainフレーム内の a[href*="mg_kyoseitaikai.php"] をクリック（新規ページが開けば切り替え）
 *   5. 会員詳細ページ（ope_mainフレーム内）の input[name="info_mess"]（お知らせメッセージ編集）をクリック
 *   6. ope_mainフレーム内の一覧テーブルから本日8:00以降の行を全件取得（3列目=送信(予定)日時）
 *   7. 各行 input[name="body"] の value からHTML本文を取得
 *   8. HTML本文からキャンペーン内容（固定値／倍率／割引）を抽出（ルーレット系は除外）
 *   9. 解析結果をLINEに通知
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { chromium } = require('playwright');
const axios = require('axios');

const LOGIN_URL  = process.env.SYSTEM_URL || 'http://manager.x7j4l2p9m1.com/mg/mg_ope.php';
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

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

// ─── Playwright: ログイン（reply-checker.js と同じ処理）─────────────

async function login(page) {
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
  console.log('[LOGIN] タイトル:', await page.title());

  const sessionLink = page.locator('a[href*="s_system"]');
  if (await sessionLink.count() > 0) {
    console.log('[LOGIN] セッション切れ検知 → クリック');
    await sessionLink.first().click();
    await page.waitForLoadState('networkidle');
  }

  await page.fill('[name="id"]',   process.env.SYSTEM_LOGIN_ID);
  await page.fill('[name="pass"]', process.env.SYSTEM_LOGIN_PASS);
  await page.click('[name="login"]');
  await page.waitForLoadState('networkidle');
  console.log('[LOGIN] 完了:', await page.title());
}

// ─── Playwright: サポート画面（mg_ope.php）を開く ───────────────────

async function openSupportPage(page) {
  await page.goto(LOGIN_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('iframe[name="ope_menu"]', { timeout: 10000 }).catch(() => {
    console.log('[WARN] ope_menuフレームが見つかりません');
  });
  console.log('[SUPPORT] 親ページ:', page.url());
  return page;
}

// ─── ope_menuフレーム内の#ffffe0行からstringID一覧を取得 ─────────────
// onclick="javascript:replay('108894512609')" からstringIDを抽出する
// （reply-checker.js の getTargetUsers と同じ抽出方法）

async function getFfffe0Candidates(page) {
  const menuFrame = page.frame({ name: 'ope_menu' });
  if (!menuFrame) {
    console.log('[SUPPORT] ope_menuフレームが取得できません');
    return [];
  }

  try {
    await menuFrame.waitForSelector('[style*="background-color: #ffffe0"]', { timeout: 10000 });
  } catch (_) {
    console.log('[SUPPORT] #ffffe0 のセルが見つかりません（タイムアウト）');
  }

  const candidates = await menuFrame.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr'));
    const results = [];
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      const isYellow = cells.some(td => (td.getAttribute('style') || '').includes('background-color: #ffffe0'));
      if (!isYellow) continue;

      const onclickEl = row.querySelector('[onclick*="replay"]');
      if (!onclickEl) continue;
      const onclickVal = onclickEl.getAttribute('onclick') || '';
      const m = onclickVal.match(/replay\(['"]([^'"]+)['"]\)/);
      if (!m) continue;

      const link = row.querySelector('a');
      const userName = (link ? link.textContent : onclickEl.textContent).trim();

      results.push({ userName, stringID: m[1] });
    }
    return results;
  });

  console.log(`[SUPPORT] #ffffe0 候補: ${candidates.length}件`);
  return candidates;
}

// ─── ope_menuフレーム内でreplay(stringID)相当のform submitを実行し、 ──
// ope_mainフレームの#bodyKakuninが更新されるのを待つ
// （reply-checker.js の processUsers と同じAjax更新待ちパターン）

async function clickTargetUserByStringID(page, stringID) {
  const menuFrame = page.frame({ name: 'ope_menu' });
  if (!menuFrame) {
    console.log('[SUPPORT] ope_menuフレームが取得できません');
    return false;
  }
  const mainFrame = page.frame({ name: 'ope_main' });
  if (!mainFrame) {
    console.log('[SUPPORT] ope_mainフレームが取得できません');
    return false;
  }

  // submit前に#bodyKakuninを空にする（前候補の内容の誤検知防止）
  await mainFrame.evaluate(() => {
    const el = document.querySelector('#bodyKakunin');
    if (el) el.innerHTML = '';
  });

  try {
    await menuFrame.evaluate((sid) => {
      document.getElementById(sid).submit();
    }, stringID);
  } catch (e) {
    console.log(`[SUPPORT] stringID="${stringID}" のform submitに失敗: ${e.message}`);
    return false;
  }

  try {
    await mainFrame.waitForFunction(() => {
      const el = document.querySelector('#bodyKakunin');
      return el !== null && el.innerHTML.length > 0;
    }, { timeout: 15000 });
  } catch (_) {
    console.log(`[SUPPORT] stringID="${stringID}": #bodyKakunin のタイムアウト`);
  }

  return true;
}

// ─── ope_mainフレーム内のdiv.bodyNaibuからユーザーの最新メッセージ本文を取得 ──
// 鑑定士メッセージ（#90EE90背景を祖先に持つdiv.bodyNaibu）は除外し、
// DOM順で先頭（＝最新）のユーザーメッセージ本文を返す

async function getLatestUserMessage(page) {
  const mainFrame = page.frame({ name: 'ope_main' });
  if (!mainFrame) {
    console.log('[SUPPORT] ope_mainフレームが取得できません');
    return '';
  }

  try {
    const texts = await mainFrame.evaluate(() => {
      function normStyle(el) {
        return (el.getAttribute('style') || '').replace(/\s/g, '').toLowerCase();
      }
      function isKanteishiAncestor(el) {
        let node = el.parentElement;
        while (node) {
          const bg = normStyle(node);
          if (bg.includes('90ee90') || bg.includes('144,238,144')) return true;
          node = node.parentElement;
        }
        return false;
      }
      const all = Array.from(document.querySelectorAll('div.bodyNaibu'));
      const userOnly = all.filter(el => !isKanteishiAncestor(el));
      return userOnly
        .map(el => (el.textContent || '').trim())
        .filter(t => t.length > 0);
    });

    const latest = texts[0] || '';
    console.log(`[SUPPORT] div.bodyNaibu 取得件数: ${texts.length}件`);
    console.log(`[SUPPORT] 最新メッセージ(先頭100文字): "${latest.slice(0, 100)}"`);
    return latest;
  } catch (e) {
    console.error('[ERROR] getLatestUserMessage:', e.message);
    return '';
  }
}

// ─── ポイント関連の問い合わせかどうかを判定 ─────────────────────────
// （「合わない」「足りない」「おかしい」「違う」「間違い」「少ない」のいずれか）
// かつ（「ポイント」「pt」「PT」のいずれか）を含む場合のみ true

const NEGATIVE_KEYWORDS = ['合わない', '足りない', 'おかしい', '違う', '間違い', '少ない'];
const POINT_KEYWORDS = ['ポイント', 'pt', 'PT'];

function isPointRelatedInquiry(text) {
  if (!text) return false;
  const hasNegative = NEGATIVE_KEYWORDS.some(k => text.includes(k));
  const hasPoint = POINT_KEYWORDS.some(k => text.includes(k));
  return hasNegative && hasPoint;
}

// ─── ope_mainフレーム内のユーザー名リンクをクリックし会員詳細へ ─────
// a[href*="mg_kyoseitaikai.php"]をクリックするとope_mainフレームのsrcが
// mg_kyoseitaikai.phpに切り替わる（popupや親ページ遷移は発生しない）

async function openMemberDetail(page) {
  const mainFrame = page.frame({ name: 'ope_main' });
  if (!mainFrame) throw new Error('ope_mainフレームが取得できません');

  const linkSelector = 'a[href*="mg_kyoseitaikai.php"]';
  await mainFrame.waitForSelector(linkSelector, { timeout: 10000 });
  await mainFrame.click(linkSelector);

  await mainFrame.waitForSelector('input[name="info_mess"]', { timeout: 10000 });
  return mainFrame;
}

// ─── 一覧テーブルから本日8:00以降の行を取得（3列目=送信(予定)日時）──
// target: Page または Frame

// 2段階で処理する:
//   1) 3列目（送信(予定)日時）のテキストのみを解析し、本日8:00以降かどうかを判定する
//      （この時点では「HTMLメールとしてみる」ボタンはクリックしない）
//   2) 条件を満たした行についてのみ、本文を取得する
//      本文は input[name="body"] を最優先に探し、無ければ「HTMLメールとしてみる」
//      ボタンと同じform内のhidden input・textareaを順に探す
async function getTodayCampaignRows(target) {
  const { matched, debugRows } = await target.evaluate(() => {
    // 日時テキストを month/day/hour/minute に分解する
    // 対応形式: "2026/07/03 09:15" ・ "2026-07-03 09:15" ・ "07月03日 09時15分"（年なし可）
    function parseDateCell(text) {
      let m = text.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})[^\d]+(\d{1,2})[:時](\d{1,2})/);
      if (m) {
        return { month: parseInt(m[2], 10), day: parseInt(m[3], 10), hour: parseInt(m[4], 10), minute: parseInt(m[5], 10) };
      }
      m = text.match(/(?:\d{4}年)?(\d{1,2})月(\d{1,2})日[^\d]*(\d{1,2})時(\d{1,2})分/);
      if (m) {
        return { month: parseInt(m[1], 10), day: parseInt(m[2], 10), hour: parseInt(m[3], 10), minute: parseInt(m[4], 10) };
      }
      return null;
    }

    // 「HTMLメールとしてみる」ボタンを持つ行だけを「一覧テーブルの行」とみなす
    const candidateRows = Array.from(document.querySelectorAll('tr'))
      .filter(tr => tr.querySelector('input[value="HTMLメールとしてみる"]'));

    // ボタンをクリックせず、同じform内のhidden input／textareaから本文を取得する
    function extractBody(tr, htmlButton) {
      const scope = (htmlButton && htmlButton.closest('form')) || tr;

      const bodyInput = scope.querySelector('input[name="body"]');
      if (bodyInput) {
        return { source: 'input[name="body"]', value: bodyInput.getAttribute('value') || bodyInput.value || '' };
      }

      const hiddenInputs = Array.from(scope.querySelectorAll('input[type="hidden"]'));
      const hiddenBody = hiddenInputs.find(el => el !== htmlButton && (el.getAttribute('value') || el.value || '').length > 0);
      if (hiddenBody) {
        return { source: `input[type="hidden"][name="${hiddenBody.name}"]`, value: hiddenBody.getAttribute('value') || hiddenBody.value || '' };
      }

      const textarea = scope.querySelector('textarea');
      if (textarea) {
        return { source: 'textarea', value: textarea.value || textarea.textContent || '' };
      }

      return { source: 'none', value: '' };
    }

    const now = new Date();
    const nowMonth = now.getMonth() + 1;
    const nowDay = now.getDate();

    const debugRows = [];
    const matched = [];

    for (const tr of candidateRows) {
      const cells = Array.from(tr.querySelectorAll('td'));
      const dateCellText = cells[2] ? (cells[2].textContent || '').trim() : ''; // 3列目 = 送信(予定)日時
      const parsed = parseDateCell(dateCellText);
      debugRows.push({ dateCellText, parsed });

      // ─── 1) 日時判定（本文はまだ読まない）───────────────────────
      if (!parsed) continue;
      const isToday = parsed.month === nowMonth && parsed.day === nowDay;
      const isAfter8 = (parsed.hour * 60 + parsed.minute) >= 8 * 60;
      if (!isToday || !isAfter8) continue;

      // ─── 2) 条件を満たした行のみ本文を取得 ────────────────────
      const htmlButton = tr.querySelector('input[value="HTMLメールとしてみる"]');
      const body = extractBody(tr, htmlButton);

      // タイトルは4列目（cells[3]）
      const title = cells[3] ? (cells[3].textContent || '').trim() : '';

      matched.push({ dateText: dateCellText, title, bodyHtml: body.value, bodySource: body.source });
    }

    return { matched, debugRows };
  });

  console.log(`[STEP6] 「HTMLメールとしてみる」保有行: ${debugRows.length}件`);
  for (const r of debugRows) {
    console.log(`[STEP6]   日時列="${r.dateCellText}" → 解析=${JSON.stringify(r.parsed)}`);
  }
  console.log(`[STEP6] 本日8時以降に該当: ${matched.length}件`);
  for (const m of matched) {
    console.log(`[STEP6]   本文取得元: ${m.bodySource}`);
  }

  return matched;
}

// ─── HTML本文からキャンペーン内容を抽出・解析 ───────────────────────
// input[name="body"]のvalueはHTMLタグを含む生のHTML文字列。
// 以前はpage.evaluate()内でDOMParser＋ブロック要素境界により「行」を
// 復元してから条件・効果を対応付けていたが、タグ構成によっては複数件が
// 1つの「行」に混在し、非グローバルmatch()が最初の1件しか拾えず
// 取りこぼすケースがあった（例: ブラウザコンソールでは
// body.match(/(\d+)pt(?:の割引|引き|割引)/g)が4件ヒットするのに
// Playwright側の解析では2件しか取得できない）。
// タグ構造に依存しないよう、生HTML文字列に対して正規表現で
// 直接パターンマッチする方式に変更する。
//
// 3種類のメールパターンを判別して解析する:
//   パターン1: 補助ポイント（「○○円以上のご購入」＋「合計補助」＋「○○円分」）
//   パターン2: 割引ポイント（「○○ptの割引」「○○pt割引」「○○pt引き」）
//   パターン3: 倍率ポイント（「○○円以上の(ご)購入」＋「○.○倍」）
//
// 戻り値: { subsidies: [...], discounts: [...], multipliers: [...] }

const PT_EFFECT_RE = /([\d,]+)\s*pt\s*(?:の\s*割引|割引|引き)/;

// <b>等の装飾タグが金額とキーワードの間に割り込むと（例: "合計補助 <b>500</b>円分"）
// タグを残したままでは正規表現が数字と後続キーワードを連続と認識できず
// マッチに失敗するため、解析前にタグを除去したプレーンテキストへ変換する。
// 「■」の出現位置や各キーワードの前後関係だけを見るこの解析方式では
// タグによる行・ブロック構造は不要なため、除去してしまって問題ない
function stripTags(html) {
  return html.replace(/<[^>]+>/g, '');
}

// 「○○円以上のご購入」ごとに、次の閾値が現れるまでの範囲（＝同じカード
// 相当）に限定して「合計補助」直後の「○○円分」のみを補助金額として
// 採用する。これにより閾値と無関係な円表記の重複検出を防ぐ
function parseSubsidyPattern(text) {
  const subsidies = [];
  const thresholdRe = /([\d,]+)\s*円以上のご購入/g;
  const matches = [...text.matchAll(thresholdRe)];

  for (let i = 0; i < matches.length; i++) {
    const thresholdAmount = matches[i][1];
    const scopeStart = matches[i].index + matches[i][0].length;
    const scopeEnd = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const scope = text.slice(scopeStart, scopeEnd);

    const subsidyMatch = scope.match(/合計補助[\s\S]*?([\d,]+)\s*円分/);
    if (!subsidyMatch) continue;

    const value = subsidyMatch[1];
    const display = `${thresholdAmount}円以上 → ${value}円分補助`;
    subsidies.push({ type: 'subsidy', thresholdAmount, value, display });
  }

  return subsidies;
}

// 「■」を区切りとして条件ブロックごとにテキストを分割し、各ブロック内で
// 条件（無償適用／○○円以上のご入金）と効果（○○pt割引・引き）を抽出する。
// 「■」は本文中に条件の数だけしか現れない区切り文字であるため、
// タグ除去後のテキストに対して行っても件数分だけ正しく分割できる
//   「■ 無償適用」→「○○ptの割引／○○pt割引」（デフォルト3時間）
//   「■ ○○円以上のご入金」→「○○pt引き／○○pt割引」（デフォルト終日）
function parseDiscountPattern(text) {
  const discounts = [];
  const segments = text.split('■').slice(1); // 最初の■より前はどの条件にも属さないため除外

  for (const segment of segments) {
    const durationMatch = segment.match(/[（(]([^）)]+)[）)]/);
    const duration = durationMatch ? durationMatch[1] : null;

    if (/無償適用/.test(segment)) {
      const ptMatch = segment.match(PT_EFFECT_RE);
      if (!ptMatch) continue;
      const value = ptMatch[1];
      const finalDuration = duration || '3時間';
      const display = `無償適用 → ${value}pt割引（${finalDuration}）`;
      discounts.push({ type: 'discount', condition: '無償適用', value, duration: finalDuration, display });
      continue;
    }

    const depositMatch = segment.match(/([\d,]+)\s*円以上のご入金/);
    if (!depositMatch) continue;
    const ptMatch = segment.match(PT_EFFECT_RE);
    if (!ptMatch) continue;

    const thresholdAmount = depositMatch[1];
    const value = ptMatch[1];
    const finalDuration = duration || '終日';
    const display = `${thresholdAmount}円以上 → ${value}pt割引（${finalDuration}）`;
    discounts.push({ type: 'discount', condition: `${thresholdAmount}円以上`, value, duration: finalDuration, display });
  }

  return discounts;
}

const MULTIPLIER_RE = /([\d.]+)\s*倍/;

// 「■」を区切りとして条件ブロックごとにテキストを分割し、各ブロック内で
// 「○○円以上の(ご)購入」条件と「○.○倍」の倍率効果を抽出する
//   「■ ○○円以上の(ご)購入」→「○.○倍付与」
function parseMultiplierPattern(text) {
  const multipliers = [];
  const segments = text.split('■').slice(1); // 最初の■より前はどの条件にも属さないため除外

  for (const segment of segments) {
    const thresholdMatch = segment.match(/([\d,]+)\s*円以上の(?:ご)?購入/);
    if (!thresholdMatch) continue;
    const multiplierMatch = segment.match(MULTIPLIER_RE);
    if (!multiplierMatch) continue;

    const thresholdAmount = thresholdMatch[1];
    const value = multiplierMatch[1];
    const display = `${thresholdAmount}円以上 → ${value}倍付与`;
    multipliers.push({ type: 'multiplier', thresholdAmount, value, display });
  }

  return multipliers;
}

function parseCampaignHTML(bodyHtml) {
  if (!bodyHtml) return { subsidies: [], discounts: [], multipliers: [] };

  const text = stripTags(bodyHtml);

  const subsidies = (text.includes('円以上のご購入') && text.includes('合計補助'))
    ? parseSubsidyPattern(text)
    : [];

  const discounts = PT_EFFECT_RE.test(text) ? parseDiscountPattern(text) : [];

  const multipliers = MULTIPLIER_RE.test(text) ? parseMultiplierPattern(text) : [];

  return { subsidies, discounts, multipliers };
}

// ─── LINE通知メッセージ組み立て ─────────────────────────────────────

const CAMPAIGN_TYPE_LABELS = { subsidy: '補助ポイント：', discount: '割引ポイント：', multiplier: '倍率ポイント：' };

function buildResultMessage(userName, mails) {
  const lines = ['【キャンペーン解析結果】', `ユーザー：${userName}`, `配信メール数：${mails.length}件`, ''];
  mails.forEach((mail, i) => {
    lines.push(`【メール${i + 1}】タイトル：${mail.title}`);
    if (mail.campaigns.length === 0) {
      lines.push('（キャンペーン内容なし）');
    } else {
      for (const type of Object.keys(CAMPAIGN_TYPE_LABELS)) {
        const items = mail.campaigns.filter(c => c.type === type);
        if (items.length === 0) continue;
        lines.push(CAMPAIGN_TYPE_LABELS[type]);
        for (const c of items) lines.push(`・${c.display}`);
      }
    }
    lines.push('');
  });
  return lines.join('\n').trim();
}

// ─── エントリポイント ─────────────────────────────────────────────

async function checkSupport() {
  console.log('=== support-checker 起動 ===');

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    httpCredentials: {
      username: process.env.BASIC_AUTH_ID,
      password: process.env.BASIC_AUTH_PASS,
    },
  });

  try {
    const page = await context.newPage();

    console.log('[STEP1] ログイン開始');
    await login(page);

    console.log('[STEP2] サポート画面(mg_ope.php)を開く');
    await openSupportPage(page);

    console.log('[STEP3] #ffffe0 の行を検出してユーザー名欄をクリック');
    const candidates = await getFfffe0Candidates(page);
    if (candidates.length === 0) {
      await sendLine('サポート画面に対象ユーザー（#ffffe0）が見つかりませんでした');
      return;
    }

    // ─── STEP3-4間: ユーザーの最新問い合わせ本文がポイント関連かを確認 ──
    // 該当しない候補はスキップし、次の#ffffe0行を確認する
    let target = null;
    for (const candidate of candidates) {
      const clicked = await clickTargetUserByStringID(page, candidate.stringID);
      if (!clicked) continue;

      const latestMessage = await getLatestUserMessage(page);
      console.log(`[STEP3] ${candidate.userName} の最新メッセージ: "${latestMessage.slice(0, 80)}"`);

      if (!isPointRelatedInquiry(latestMessage)) {
        console.log(`[STEP3] ${candidate.userName}: ポイント関連の問い合わせではないためスキップ`);
        continue;
      }

      console.log(`[STEP3] ${candidate.userName}: ポイント関連の問い合わせと判定`);
      target = candidate;
      break;
    }

    if (!target) {
      await sendLine('ポイント関連の問い合わせを持つ対象ユーザーが見つかりませんでした');
      console.log('=== support-checker 完了（該当ユーザーなし） ===');
      return;
    }

    // a[href*="mg_kyoseitaikai.php"]をクリックするとope_mainフレームのsrcが
    // 会員詳細ページ（mg_kyoseitaikai.php）に切り替わる（同一フレーム内で完結）
    console.log('[STEP4] ope_main内のユーザー名リンクをクリックし、会員詳細ページの表示を待機');
    const mainFrame = await openMemberDetail(page);

    const infoMessCount = await mainFrame.locator('input[name="info_mess"]').count();
    console.log('[DEBUG] info_mess件数:', infoMessCount);

    // info_messボタンはope_mainフレーム内にあるため、遷移後のURLも
    // page.url()ではなくmainFrame.url()で確認する必要がある
    console.log('[STEP5] 「お知らせメッセージ編集」ボタンをクリック');
    console.log('[DEBUG] クリック前URL:', mainFrame.url());
    await mainFrame.click('input[name="info_mess"]');
    await new Promise(r => setTimeout(r, 3000));

    const frameUrl = mainFrame.url();
    console.log('[STEP5] フレームURL:', frameUrl);

    // frameUrlにmg_mail_editが含まれていればmainFrameをmailPageとして使用
    const mailPage = frameUrl.includes('mg_mail_edit') ? mainFrame : null;

    if (!mailPage) {
      console.log('[STEP5] mg_mail_edit.phpへの遷移が確認できませんでした');
      return;
    }

    console.log('[STEP6] mg_mail_edit.phpのtableから本日8時以降の配信メール一覧を取得');
    await mailPage.waitForSelector('table', { timeout: 10000 });
    const mailRows = await getTodayCampaignRows(mailPage);
    console.log(`[STEP6] 対象件数: ${mailRows.length}件`);
    if (mailRows.length > 0) {
      console.log(`[STEP6] 1行目 送信日時: "${mailRows[0].dateText}"`);
      console.log(`[STEP6] 1行目 本文(先頭100文字): "${(mailRows[0].bodyHtml || '').slice(0, 100)}"`);
    }

    if (mailRows.length === 0) {
      await sendLine(`【キャンペーン解析結果】\nユーザー：${target.userName}\n配信メール数：0件\n本日8時以降のお知らせメールは見つかりませんでした`);
      console.log('=== support-checker 完了（対象メールなし） ===');
      return;
    }

    console.log('[STEP7-8] 各メールの本文からキャンペーン内容を解析');
    const mails = mailRows.map((row, i) => {
      const { subsidies, discounts, multipliers } = parseCampaignHTML(row.bodyHtml);
      const campaigns = [...subsidies, ...discounts, ...multipliers];
      console.log(`[CAMPAIGN] メール${i + 1} "${row.title}" (${row.dateText}): ${campaigns.length}件検出（補助${subsidies.length}／割引${discounts.length}／倍率${multipliers.length}）`);
      return { title: row.title || `メール${i + 1}`, campaigns };
    });

    console.log('[STEP9] LINEに解析結果を通知');
    await sendLine(buildResultMessage(target.userName, mails));

    console.log('=== support-checker 完了 ===');
  } catch (err) {
    console.error('[FATAL]', err.message, err.stack);
    await sendLine(`【システムエラー】support-checker: ${err.message}`);
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  checkSupport();
}

module.exports = { checkSupport };

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
 *   4. ope_mainフレーム内の a[href*="mg_kyoseitaikai.php"] をクリック（新規ページが開けば切り替え）
 *   5. 会員詳細ページの input[name="info_mess"]（お知らせメッセージ編集）をクリック
 *   6. 一覧テーブルから本日8:00以降の行を全件取得（3列目=送信(予定)日時）
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

// ─── ope_menuフレーム内で#ffffe0の行を検出しユーザー名欄をクリック ───

async function findAndClickTargetUser(page) {
  const menuFrame = page.frame({ name: 'ope_menu' });
  if (!menuFrame) {
    console.log('[SUPPORT] ope_menuフレームが取得できません');
    return null;
  }

  try {
    await menuFrame.waitForSelector('[style*="background-color: #ffffe0"]', { timeout: 10000 });
  } catch (_) {
    console.log('[SUPPORT] #ffffe0 のセルが見つかりません（タイムアウト）');
  }

  const result = await menuFrame.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr'));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      const yellowCell = cells.find(td => (td.getAttribute('style') || '').includes('background-color: #ffffe0'));
      if (!yellowCell) continue;

      const link = row.querySelector('a');
      const onclickEl = row.querySelector('[onclick]');
      const userName = (link ? link.textContent : (onclickEl ? onclickEl.textContent : '')).trim();

      if (link) {
        link.click();
        return { found: true, userName, method: 'a.click()' };
      }
      if (onclickEl) {
        onclickEl.click();
        return { found: true, userName, method: 'onclickEl.click()' };
      }
      return { found: true, userName, method: 'クリック対象なし' };
    }
    return { found: false, userName: '', method: '' };
  });

  if (!result.found) {
    console.log('[SUPPORT] #ffffe0 の行が見つかりません');
    return null;
  }

  console.log(`[SUPPORT] #ffffe0 検出: ユーザー名="${result.userName}" (${result.method})`);
  await page.waitForTimeout(1000); // ope_mainのAjax更新待ち
  return { userName: result.userName };
}

// ─── クリック後に新規ページ(popup)が開けばそちらへ切り替える ─────────
// target: Page または Frame（どちらも click / waitForLoadState を持つ）

async function clickAndFollow(target, selector, timeoutMs = 8000) {
  const context = typeof target.context === 'function' ? target.context() : target.page().context();
  const popupPromise = context.waitForEvent('page', { timeout: timeoutMs }).catch(() => null);

  await target.click(selector);
  console.log(`[SUPPORT] "${selector}" をクリックしました`);

  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState('networkidle').catch(() => {});
    console.log(`[SUPPORT] 新しいページに切り替え: ${popup.url()}`);
    return popup;
  }

  await target.waitForLoadState('networkidle').catch(() => {});
  return target;
}

// ─── ope_mainフレーム内のユーザー名リンクをクリックし会員詳細へ ─────

async function openMemberDetail(page) {
  const mainFrame = page.frame({ name: 'ope_main' });
  if (!mainFrame) throw new Error('ope_mainフレームが取得できません');

  const linkSelector = 'a[href*="mg_kyoseitaikai.php"]';
  await mainFrame.waitForSelector(linkSelector, { timeout: 10000 });
  return clickAndFollow(mainFrame, linkSelector);
}

// ─── 一覧テーブルから本日8:00以降の行を取得（3列目=送信(予定)日時）──
// target: Page または Frame

// 2段階で処理する:
//   1) 3列目（送信(予定)日時）のテキストのみを解析し、本日8:00以降かどうかを判定する
//      （この時点では本文列には一切触れない。「HTMLメールとしてみる」ボタンもクリックしない）
//   2) 条件を満たした行についてのみ、本文列 input[name="body"] の value属性を取得する
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

    // ナビゲーション等の無関係なtr混入を避けるため、本文input[name="body"]を持つ行だけを
    // 「一覧テーブルの行」とみなす
    const candidateRows = Array.from(document.querySelectorAll('tr')).filter(tr => tr.querySelector('input[name="body"]'));

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

      // ─── 2) 条件を満たした行のみ本文列 input[name="body"] を取得 ──
      const bodyInput = tr.querySelector('input[name="body"]');
      const bodyHtml = bodyInput ? (bodyInput.getAttribute('value') || bodyInput.value || '') : '';

      // タイトル列は明示セレクター指定なしのため、日時列以外の最初の非空セルを採用
      const titleCell = cells.find(td => td !== cells[2] && (td.textContent || '').trim().length > 0);
      const title = titleCell ? titleCell.textContent.trim() : '';

      matched.push({ dateText: dateCellText, title, bodyHtml });
    }

    return { matched, debugRows };
  });

  console.log(`[STEP6] 本文input保有行: ${debugRows.length}件`);
  for (const r of debugRows) {
    console.log(`[STEP6]   日時列="${r.dateCellText}" → 解析=${JSON.stringify(r.parsed)}`);
  }
  console.log(`[STEP6] 本日8時以降に該当: ${matched.length}件`);

  return matched;
}

// ─── HTML本文からキャンペーン内容を抽出・解析 ───────────────────────
// パターン: ①固定値（〇円以上購入→〇円分/ポイント追加） ②倍率（ポイント〇倍） ③割引（〇ポイント割引適用）
// ボーナスルーレット・MAXボーナスルーレット関連の記述は除外する

function htmlToLines(html) {
  if (!html) return [];
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
}

function parseCampaignHTML(html) {
  const lines = htmlToLines(html);
  const campaigns = [];

  for (const line of lines) {
    if (/ボーナスルーレット|MAXボーナスルーレット/.test(line)) {
      console.log(`[CAMPAIGN] ルーレット関連のため除外: "${line.slice(0, 40)}"`);
      continue;
    }

    const amounts = [...line.matchAll(/([\d,]+)\s*円/g)].map(m => m[1]);
    if (amounts.length === 0) continue;
    const thresholdAmount = amounts[0];

    let type = null;
    let value = null;

    if (/割引/.test(line)) {
      const m = line.match(/([\d,]+)\s*(?:ポイント|pt|Pt)[^。]{0,10}割引/);
      if (m) { type = 'discount'; value = m[1]; }
    } else if (/倍/.test(line)) {
      const m = line.match(/([\d.]+)\s*倍/);
      if (m) { type = 'multiplier'; value = m[1]; }
    } else if (/追加|プレゼント|付与/.test(line)) {
      const m = line.match(/([\d,]+)\s*円分/) || line.match(/([\d,]+)\s*(?:ポイント|pt|Pt)/);
      if (m) {
        type = 'fixed';
        value = m[1];
      } else if (amounts.length >= 2) {
        type = 'fixed';
        value = amounts[1];
      }
    }

    if (!type || !value) continue;

    let display;
    if (type === 'fixed')      display = `${thresholdAmount}円購入 → ${value}pt追加`;
    else if (type === 'multiplier') display = `${thresholdAmount}円購入 → ポイント${value}倍`;
    else                        display = `${thresholdAmount}円購入 → ${value}ポイント割引適用`;

    console.log(`[CAMPAIGN] 検出(${type}): "${display}" ← "${line.slice(0, 60)}"`);
    campaigns.push({ type, thresholdAmount, value, display, raw: line });
  }

  return campaigns;
}

// ─── LINE通知メッセージ組み立て ─────────────────────────────────────

function buildResultMessage(userName, mails) {
  const lines = ['【キャンペーン解析結果】', `ユーザー：${userName}`, `配信メール数：${mails.length}件`, ''];
  mails.forEach((mail, i) => {
    lines.push(`【メール${i + 1}】タイトル：${mail.title}`);
    lines.push('キャンペーン内容：');
    if (mail.campaigns.length === 0) {
      lines.push('（キャンペーン内容を検出できませんでした）');
    } else {
      for (const c of mail.campaigns) lines.push(`・${c.display}`);
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
    const target = await findAndClickTargetUser(page);
    if (!target) {
      await sendLine('サポート画面に対象ユーザー（#ffffe0）が見つかりませんでした');
      return;
    }

    console.log('[STEP4] ope_main内のユーザー名リンクをクリック');
    await openMemberDetail(page);

    // 「お知らせメッセージ編集」はope_mainフレーム内のボタンだが、クリックすると
    // ope_mainフレーム内には留まらず、mg_mail_edit.php?u_id=...&info_mess=... という
    // 新しいページへ遷移する（同一タブ内の遷移／新タブでの遷移のどちらもあり得るため
    // 両方を待ち受け、遷移先ページを直接操作する）。
    console.log('[STEP5] 「お知らせメッセージ編集」ボタンをクリック');
    const mainFrame = page.frame({ name: 'ope_main' });
    if (!mainFrame) throw new Error('ope_mainフレームが取得できません');
    await mainFrame.waitForSelector('input[name="info_mess"]', { timeout: 10000 });

    const browserContext = page.context();
    const popupPromise = browserContext.waitForEvent('page', { timeout: 10000 }).catch(() => null);
    const navPromise = page.waitForNavigation({ waitUntil: 'load', timeout: 10000 }).catch(() => null);

    await mainFrame.click('input[name="info_mess"]');

    const popup = await popupPromise;
    let mailEditPage;
    if (popup) {
      await popup.waitForLoadState('load').catch(() => {});
      console.log(`[STEP5] 新しいタブへ遷移: ${popup.url()}`);
      mailEditPage = popup;
    } else {
      await navPromise;
      console.log(`[STEP5] 同一ページ内で遷移: ${page.url()}`);
      mailEditPage = page;
    }

    console.log('[STEP6] mg_mail_edit.phpのtableから本日8時以降の配信メール一覧を取得');
    await mailEditPage.waitForSelector('table', { timeout: 10000 });
    const mailRows = await getTodayCampaignRows(mailEditPage);
    console.log(`[STEP6] 対象件数: ${mailRows.length}件`);

    if (mailRows.length === 0) {
      await sendLine(`【キャンペーン解析結果】\nユーザー：${target.userName}\n配信メール数：0件\n本日8時以降のお知らせメールは見つかりませんでした`);
      console.log('=== support-checker 完了（対象メールなし） ===');
      return;
    }

    console.log('[STEP7-8] 各メールの本文からキャンペーン内容を解析');
    const mails = mailRows.map((row, i) => {
      const campaigns = parseCampaignHTML(row.bodyHtml);
      console.log(`[CAMPAIGN] メール${i + 1} "${row.title}" (${row.dateText}): ${campaigns.length}件検出`);
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

/**
 * mail-checker.js
 * XserverのIMAPを定期チェックし、銀行入金通知メールを検知して
 * Playwrightでポイント追加処理を行いLINEで通知するスクリプト
 *
 * 配置場所: /root/rune-bot/mail-checker.js
 * 実行: node mail-checker.js (PM2推奨: pm2 start mail-checker.js)
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const imapSimple = require('imap-simple');
const { simpleParser } = require('mailparser');
const { chromium } = require('playwright');
const axios = require('axios');

// ─── 設定 ─────────────────────────────────────────────────────────
const TARGET_SUBJECT = '[SUI 銀行口座決済サービス] 入金のお知らせ';
const CHECK_INTERVAL_MS = 60 * 1000; // 1分ごとにチェック
const DRY_RUN = process.env.DRY_RUN === 'true';
const MAX_PROCESS = parseInt(process.env.MAX_PROCESS || '0', 10); // 0 = 無制限
const TEST_MODE = process.env.TEST_MODE === 'true';

// プルダウンに存在するプリセット金額（円）
const PRESET_AMOUNTS = [1000, 1500, 3000, 5000, 10000, 15000, 20000, 30000, 50000, 70000, 100000];

// ─── ユーティリティ ──────────────────────────────────────────────────

// 全角数字・英字を半角に変換
function toHalfWidth(str) {
  return String(str).replace(/[Ａ-Ｚａ-ｚ０-９]/g, c =>
    String.fromCharCode(c.charCodeAt(0) - 0xFEE0)
  );
}

// 依頼人名から会員IDを抽出
function extractMemberId(name) {
  const half = toHalfWidth(name).trim();
  const match = half.match(/\d+/);
  return match ? match[0] : null;
}

// ポイント計算: 入金額÷10 + 入金額×0.5%（端数切り捨て）
function calcPoints(amount) {
  return Math.floor(amount / 10 + amount * 0.005);
}

// LINE Messaging API（broadcast）へ通知
async function sendLine(message) {
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/broadcast',
      { messages: [{ type: 'text', text: message }] },
      { headers: {
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
      } }
    );
    await new Promise(resolve => setTimeout(resolve, 1000)); // 429対策
  } catch (err) {
    console.error('LINE通知エラー:', err.message);
  }
}

// メール本文から依頼人名を抽出（■依頼人名\n次行に値）
function extractSenderName(text) {
  const match = text.match(/■依頼人名\s*\n(.+)/);
  return match ? match[1].trim() : null;
}

// メール本文から入金額（円）を抽出（■金額\n次行に「10,000円」形式）
function extractAmount(text) {
  const match = text.match(/■金額\s*\n([\d,]+)円/);
  if (!match) return null;
  return parseInt(match[1].replace(/,/g, ''), 10);
}

// ─── Playwright: ポイント追加処理 ───────────────────────────────────

async function addPointsViaPlaywright(memberId, amount, points) {
  const BASE_URL = 'http://manager.x7j4l2p9m1.com/mg/';

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    httpCredentials: {
      username: process.env.BASIC_AUTH_ID,
      password: process.env.BASIC_AUTH_PASS,
    },
  });
  const page = await context.newPage();

  try {
    // ── ログインページを開く（ベーシック認証はコンテキストで処理）──
    await page.goto(BASE_URL + 'mg_ope.php', { waitUntil: 'networkidle' });
    console.log('[DEBUG] ページタイトル:', await page.title());
    await page.screenshot({ path: '/tmp/login-debug.png' });
    console.log('[DEBUG] スクリーンショット保存: /tmp/login-debug.png');

    // ── ログインフォームを入力・送信 ──
    await page.fill(process.env.SEL_LOGIN_ID    || '[name="login_id"]', process.env.SYSTEM_LOGIN_ID);
    await page.fill(process.env.SEL_LOGIN_PASS  || '[name="password"]', process.env.SYSTEM_LOGIN_PASS);
    await page.click(process.env.SEL_LOGIN_SUBMIT || '[type="submit"]');
    await page.waitForLoadState('networkidle');

    // ── 会員詳細ページへ直接アクセス（検索不要）──
    const detailUrl = `${BASE_URL}mg_kyoseitaikai.php?ken=1&ken_id=${encodeURIComponent(memberId)}`;
    await page.goto(detailUrl, { waitUntil: 'networkidle' });

    // iframeがあればその中、なければページ直接で操作
    const frame = page.frame({ name: 'main' }) || page;

    // ── ポイント追加フォームを操作 ──
    const isPreset = PRESET_AMOUNTS.includes(amount);

    if (isPreset) {
      // プルダウンの値形式は「金額-ポイント数」（例: 1000-105）なので前方一致で選択
      const optionValue = await frame.evaluate((amt) => {
        const sel = document.querySelector('select[name="point_in"]');
        const opt = Array.from(sel.options).find(o => o.value.startsWith(amt + '-'));
        return opt ? opt.value : null;
      }, String(amount));

      if (!optionValue) throw new Error(`プルダウンに ${amount}円 の選択肢が見つかりません`);
      await frame.selectOption('select[name="point_in"]', optionValue);
    } else {
      // 自由入力
      await frame.click('input[name="ginkoRadio"][value="1"]');
      await frame.fill('input[name="ginkoNedan"]', String(amount));
      await frame.fill('input[name="ginkoPoint"]', String(points));
    }

    // ── ポイント追加ボタンをクリック ──
    await frame.click('input[name="point_bg2"]');
    await frame.waitForLoadState('networkidle');

    // 成功確認
    const errorEl = frame.locator('.error, .alert-danger, [class*="error"]');
    const hasError = await errorEl.count() > 0;
    if (hasError) {
      const errorText = await errorEl.first().textContent();
      throw new Error(`システムエラー: ${errorText}`);
    }

    return true;
  } finally {
    await browser.close();
  }
}

// ─── IMAPメールチェック ───────────────────────────────────────────

async function checkMail() {
  console.log(`[${new Date().toLocaleString('ja-JP')}] メールチェック開始`);

  const imapConfig = {
    imap: {
      host: process.env.IMAP_HOST,
      port: parseInt(process.env.IMAP_PORT || '993', 10),
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 10000,
      authTimeout: 10000,
      user: process.env.IMAP_USER,
      password: process.env.IMAP_PASS,
    },
  };

  let connection;
  try {
    connection = await imapSimple.connect(imapConfig);
    await connection.openBox('INBOX');

    // ── デバッグ: メールボックス全件確認 ──
    const allMessages = await connection.search(['ALL'], { bodies: ['HEADER.FIELDS (SUBJECT)'], markSeen: false });
    console.log(`  メールボックス合計: ${allMessages.length}件`);
    const recent = allMessages.slice(-5).reverse();
    for (const m of recent) {
      const headerPart = m.parts.find(p => p.which === 'HEADER.FIELDS (SUBJECT)');
      const rawSubject = headerPart ? headerPart.body.subject?.[0] || '(件名なし)' : '(取得失敗)';
      console.log(`  件名サンプル: ${JSON.stringify(rawSubject)}`);
    }
    console.log(`  検索対象件名: ${JSON.stringify(TARGET_SUBJECT)}`);

    const searchCriteria = TEST_MODE
      ? ['UNSEEN']
      : ['UNSEEN', ['SUBJECT', TARGET_SUBJECT]];
    const fetchOptions = {
      bodies: [''],
      markSeen: true,     // 処理済みメールを既読にして次回スキップ
    };
    if (TEST_MODE) console.log('  [TEST_MODE] 件名フィルターなし・最新1件のみ処理');

    let messages = await connection.search(searchCriteria, fetchOptions);
    if (TEST_MODE && messages.length > 1) messages = messages.slice(-1); // 最新1件のみ
    console.log(`  対象メール: ${messages.length}件`);

    // ── デバッグ: 最初の1件の生データを出力 ──
    if (messages.length > 0) {
      const firstRaw = messages[0].parts.find(p => p.which === '');
      if (firstRaw) {
        const rawBody = String(firstRaw.body);
        // ヘッダーとボディの境界（空行）で分割
        const headerEnd = rawBody.indexOf('\r\n\r\n') !== -1
          ? rawBody.indexOf('\r\n\r\n')
          : rawBody.indexOf('\n\n');
        const rawHeaders = headerEnd !== -1 ? rawBody.slice(0, headerEnd) : rawBody.slice(0, 1000);
        const rawBodyText = headerEnd !== -1 ? rawBody.slice(headerEnd).slice(0, 1000) : '';
        console.log('=== [DEBUG] rawHeaders ===');
        console.log(rawHeaders);
        console.log('=== [DEBUG] rawBody (先頭1000文字) ===');
        console.log(rawBodyText);
      }
    }

    let processedCount = 0;
    for (const msg of messages) {
      if (MAX_PROCESS > 0 && processedCount >= MAX_PROCESS) {
        console.log(`  [MAX_PROCESS=${MAX_PROCESS}] 処理件数上限に達したため終了`);
        break;
      }

      const rawPart = msg.parts.find(p => p.which === '');
      if (!rawPart) continue;

      let parsed;
      try {
        parsed = await simpleParser(rawPart.body);
      } catch (err) {
        console.error('メールパースエラー:', err.message);
        await sendLine(`【システムエラー】メールのパースに失敗しました：${err.message}`);
        continue;
      }

      const text = parsed.text || '';
      // ── デバッグ: パース後の件名・本文先頭を出力 ──
      console.log('=== [DEBUG] parsed.subject ===', JSON.stringify(parsed.subject));
      console.log('=== [DEBUG] parsed.text (先頭300文字) ===', text.slice(0, 300));

      const senderName = extractSenderName(text);
      const amount = extractAmount(text);

      console.log(`  依頼人名: ${senderName}  入金額: ${amount}円`);

      // 依頼人名または入金額が取得できなかった場合
      if (!senderName || !amount) {
        await sendLine(
          `【要確認】入金通知のパースに失敗しました。\n件名：${parsed.subject || TARGET_SUBJECT}\n本文（先頭200文字）：${text.slice(0, 200)}`
        );
        continue;
      }

      const memberId = extractMemberId(senderName);

      // 会員IDが判別できない場合
      if (!memberId) {
        await sendLine(
          `【要確認】入金通知が届きましたが会員IDが判別できませんでした。\n依頼人名：${senderName}\n入金額：${amount}円`
        );
        continue;
      }

      const points = calcPoints(amount);
      console.log(`  → 会員ID: ${memberId}  追加ポイント: ${points}pt`);

      if (DRY_RUN) {
        console.log(`  [DRY RUN] ポイント追加をスキップ 会員ID:${memberId} ${amount}円 → ${points}pt`);
      } else {
        try {
          await addPointsViaPlaywright(memberId, amount, points);
          await sendLine(
            `【入金処理完了】\n会員ID：${memberId}\n入金額：${amount}円\n追加ポイント：${points}pt`
          );
          console.log(`  ✓ 処理完了 会員ID:${memberId} ${amount}円 → ${points}pt`);
        } catch (err) {
          console.error('ポイント追加エラー:', err.message);
          await sendLine(
            `【処理エラー】ポイント追加に失敗しました。手動対応をお願いします。\n会員ID：${memberId}\n入金額：${amount}円\n追加ポイント：${points}pt\nエラー：${err.message}`
          );
        }
      }

      processedCount++;
    }
  } catch (err) {
    console.error('IMAPエラー:', err.message);
    // IMAP接続エラーは頻繁に通知しない（ログのみ）
  } finally {
    if (connection) {
      try { connection.end(); } catch (_) {}
    }
  }
}

// ─── 起動 ────────────────────────────────────────────────────────

console.log('=== 銀行入金メール自動処理 起動 ===');
console.log(`チェック間隔: ${CHECK_INTERVAL_MS / 1000}秒`);

// 起動直後に1回実行
checkMail().catch(console.error);

// 以降は定期実行
setInterval(() => {
  checkMail().catch(console.error);
}, CHECK_INTERVAL_MS);

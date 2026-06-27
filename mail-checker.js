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

// LINE Notify へ通知
async function sendLine(message) {
  try {
    await axios.post(
      'https://notify-api.line.me/api/notify',
      new URLSearchParams({ message }),
      { headers: { Authorization: `Bearer ${process.env.LINE_NOTIFY_TOKEN}` } }
    );
  } catch (err) {
    console.error('LINE通知エラー:', err.message);
  }
}

// メール本文（テキスト）から依頼人名を抽出
// ※ SUIサービスのメール書式に合わせて正規表現を調整すること
function extractSenderName(text) {
  const match = text.match(/依頼人名\s*[：:]\s*(.+)/);
  return match ? match[1].trim() : null;
}

// メール本文から入金額（円）を抽出
// ※ SUIサービスのメール書式に合わせて正規表現を調整すること
function extractAmount(text) {
  const match = text.match(/入金額\s*[：:]\s*([0-9０-９,，]+)\s*円/);
  if (!match) return null;
  return parseInt(toHalfWidth(match[1]).replace(/[,，]/g, ''), 10);
}

// ─── Playwright: ポイント追加処理 ───────────────────────────────────

async function addPointsViaPlaywright(memberId, amount, points) {
  const BASE_URL = 'http://manager.x7j4l2p9m1.com/mg/';

  // ベーシック認証をURLに埋め込む形式で構築
  const loginUrlObj = new URL(BASE_URL + 'mg_ope.php');
  loginUrlObj.username = process.env.BASIC_AUTH_ID;
  loginUrlObj.password = process.env.BASIC_AUTH_PASS;
  const loginUrl = loginUrlObj.toString();

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // ── ベーシック認証付きでログインページを開く ──
    await page.goto(loginUrl, { waitUntil: 'networkidle' });

    // ── ログインフォームを入力・送信 ──
    await page.fill(process.env.SEL_LOGIN_ID    || '[name="login_id"]', process.env.LOGIN_ID);
    await page.fill(process.env.SEL_LOGIN_PASS  || '[name="password"]', process.env.LOGIN_PASS);
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

    // UNSEEN → ALL に変更（テスト用。動作確認後はUNSEENに戻す）
    const searchCriteria = ['ALL', ['SUBJECT', TARGET_SUBJECT]];
    const fetchOptions = {
      bodies: [''],
      markSeen: false,    // テスト中は既読にしない
    };

    const messages = await connection.search(searchCriteria, fetchOptions);
    console.log(`  対象メール: ${messages.length}件`);

    for (const msg of messages) {
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

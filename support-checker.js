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
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic();

const LOGIN_URL  = process.env.SYSTEM_URL || 'http://manager.x7j4l2p9m1.com/mg/mg_ope.php';
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DRY_RUN    = process.env.DRY_RUN === 'true';
const SUPPORT_CHECK_TEST_MODE = process.env.SUPPORT_CHECK_TEST_MODE === 'true';

const CONTACT_TEMPLATES_PATH = path.join(__dirname, 'contact-templates.json');

// reply-checker.jsと同じLINE返信待ちファイルを共有する（server.jsのLINE
// webhookが「調整する」「スキップ」等の返信テキストをここに書き込む想定）
const STATE_FILE = '/tmp/rune-reply-state.json';
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

// ─── LINE 返信待ち（ファイルポーリング、reply-checker.js と同じ仕組み）──

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
    }, 2000);
  });
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

// ─── contact-templates.json からテンプレートIDをClaude APIで判定 ──────
// （contact-checker.js の matchTemplate と同じロジック）
// 該当なし・判定失敗時はnullを返す
async function matchTemplate(inquiryText) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 100,
    system: 'テンプレートIDのみをJSON形式で返してください。',
    messages: [{
      role: 'user',
      content: `以下の問い合わせに最も近いテンプレートIDを返してください。
該当なしの場合はnullを返してください。

テンプレートID一覧：
withdraw/mail_open/no_reply/unclear/message_to_teacher/login/point_purchase/free_period/discount_ticket

問い合わせ内容：${inquiryText}

{"templateId": "ID"} の形式で返してください。`,
    }],
  });

  const text = (response.content.find(b => b.type === 'text')?.text ?? '').trim();
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  return parsed.templateId || null;
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
  const testMode = SUPPORT_CHECK_TEST_MODE;
  const { matched, debugRows } = await target.evaluate((testMode) => {
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
      const isAfter8 = testMode ? true : (parsed.hour * 60 + parsed.minute) >= 8 * 60;
      if (!isToday || !isAfter8) continue;

      // ─── 2) 条件を満たした行のみ本文を取得 ────────────────────
      const htmlButton = tr.querySelector('input[value="HTMLメールとしてみる"]');
      const body = extractBody(tr, htmlButton);

      // タイトルは4列目（cells[3]）
      const title = cells[3] ? (cells[3].textContent || '').trim() : '';

      matched.push({ dateText: dateCellText, title, bodyHtml: body.value, bodySource: body.source });
    }

    return { matched, debugRows };
  }, testMode);

  console.log(`[STEP6] 「HTMLメールとしてみる」保有行: ${debugRows.length}件`);
  for (const r of debugRows) {
    console.log(`[STEP6]   日時列="${r.dateCellText}" → 解析=${JSON.stringify(r.parsed)}`);
  }
  if (testMode) {
    console.log(`[STEP6] テストモード: 本日の全時間帯が対象 → ${matched.length}件`);
  } else {
    console.log(`[STEP6] 本日8時以降に該当: ${matched.length}件`);
  }
  for (const m of matched) {
    console.log(`[STEP6]   本文取得元: ${m.bodySource}`);
  }

  return matched;
}

// ─── HTML本文からキャンペーン内容を抽出・解析（Claude API使用） ─────
// 正規表現／DOM解析ベースでは複雑なHTML構造のキャンペーンメールに
// 対応しきれなかったため、メール本文HTMLをそのままClaude APIに渡して
// 構造化データ（JSON）として抽出する方式に変更する。
//
// campaign.type:
//   fixed    固定ポイント補助（○○円以上 → ○○円分補助）
//   rate     倍率ポイント付与（○○円以上 → ○.○倍付与）
//   percent  ％補助（購入金額の○○％分を追加）
//   discount 割引ポイント（○○pt割引）

const CAMPAIGN_SYSTEM_PROMPT =
  'あなたはメール本文からキャンペーン情報を抽出するアシスタントです。JSONのみで回答してください。';

// output_config.format（構造化出力）でJSON形式を強制するためのスキーマ。
// 各typeで使うフィールドが異なるため、必須項目はtype/amount/unitのみとする
const CAMPAIGN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    campaigns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['fixed', 'rate', 'percent', 'discount'] },
          amount: { type: 'integer' },
          bonus: { type: 'integer' },
          rate: { type: 'number' },
          discount: { type: 'integer' },
          unit: { type: 'string' },
        },
        required: ['type', 'amount', 'unit'],
        additionalProperties: false,
      },
    },
  },
  required: ['campaigns'],
  additionalProperties: false,
};

function buildCampaignUserPrompt(bodyHtml) {
  return `以下のメール本文からキャンペーン内容を抽出してください。
購入金額と付与ポイント/倍率/割引の対応表をJSON形式で返してください。

購入金額によって補助率が異なる場合は、条件ごとに分けてください。
例：100,000円購入時は100%、それ以下は50%の場合は別々に記載してください。

ボーナスくじ、ボーナスルーレット、MAXボーナスルーレットなど
抽選形式の特典は除外してください。

同じ購入金額帯が複数ある場合は最も有利な条件のみ残してください。

${bodyHtml}

以下のJSON形式で返してください：
{
  "campaigns": [
    {"type": "fixed", "amount": 10000, "bonus": 5000, "unit": "円分"},
    {"type": "rate", "amount": 3000, "rate": 1.2, "unit": "倍"},
    {"type": "percent", "amount": 0, "rate": 50, "unit": "%"},
    {"type": "discount", "amount": 0, "discount": 30, "unit": "pt"}
  ]
}`;
}

async function parseCampaignWithClaude(bodyHtml) {
  if (!bodyHtml) return [];

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 8192,
      thinking: { type: 'adaptive' },
      system: CAMPAIGN_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildCampaignUserPrompt(bodyHtml) }],
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: CAMPAIGN_JSON_SCHEMA },
      },
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) {
      console.log('[CAMPAIGN] Claude APIレスポンスにテキストブロックがありません');
      return [];
    }

    const parsed = JSON.parse(textBlock.text);
    const campaigns = Array.isArray(parsed.campaigns) ? parsed.campaigns : [];
    console.log(`[CAMPAIGN] Claude API解析結果: ${campaigns.length}件`);
    return campaigns;
  } catch (e) {
    console.error('[ERROR] Claude APIキャンペーン解析失敗:', e.message);
    return [];
  }
}

// ─── LINE通知メッセージ組み立て ─────────────────────────────────────

const CAMPAIGN_TYPE_LABELS = {
  fixed: '補助ポイント：',
  rate: '倍率ポイント：',
  percent: '%補助：',
  discount: '割引ポイント：',
};

function formatNumber(n) {
  return Number(n).toLocaleString('en-US');
}

// Claude APIが返す生のcampaignフィールド（type/amount/bonus/rate/discount/unit）
// から、LINE通知用の表示文字列をtypeに応じて組み立てる
function formatCampaignDisplay(c) {
  switch (c.type) {
    case 'fixed':
      return `${formatNumber(c.amount)}円以上 → ${formatNumber(c.bonus)}円分補助`;
    case 'rate':
      return `${formatNumber(c.amount)}円以上 → ${c.rate}倍付与`;
    case 'percent':
      return `購入金額の${c.rate}%分を追加`;
    case 'discount':
      return `${c.discount}pt割引`;
    default:
      return JSON.stringify(c);
  }
}

// ─── 入金額から期待ポイントを計算する ───────────────────────────────
// 通常付与 = 入金額÷10（10円 = 1pt）、サービスポイント = 入金額×0.5%
// に加え、キャンペーン条件（campaigns、全メール分をまとめて渡す）から
// 補助分を加算する。
//
// ・fixed/rate/percentは、入金額が閾値(amount)以上のもののうち
//   最も有利な条件のみを採用する（複数条件の合算はしない）
// ・discount（pt割引）は鑑定料金の割引であり入金ポイント付与とは
//   無関係なため、この計算には含めない
// ・fixed（固定補助）・percentのbonusキー/割合は円単位のため、÷10してpt換算する
// ・rateは「通常ポイントの○.○倍」を意味するため、通常付与分
//   （サービスポイントは含まない）に対する増加分のみを補助として計上する
//   （既にpt単位のため÷10は不要）
//
// ※ 複数キャンペーンの組み合わせルールは実際の運用に合わせて要調整
function calcExpectedPoints(amount, campaigns) {
  const normalPt = Math.floor(amount / 10);
  const servicePt = Math.floor(amount * 0.005);

  let campaignBonus = 0;

  const fixedApplicable = campaigns.filter(c => c.type === 'fixed' && amount >= c.amount);
  if (fixedApplicable.length > 0) {
    // bonusは円単位なので÷10してptに変換
    campaignBonus += Math.max(...fixedApplicable.map(c => Math.floor(c.bonus / 10)));
  }

  const rateApplicable = campaigns.filter(c => c.type === 'rate' && amount >= c.amount);
  if (rateApplicable.length > 0) {
    const bestRate = Math.max(...rateApplicable.map(c => c.rate));
    // (bestRate - 1)を先に計算すると浮動小数点誤差で1pt程度ずれることが
    // あるため（例: 1.2 - 1 = 0.19999999999999996）、乗算を先に行い
    // 丸めてから通常付与分を差し引く
    campaignBonus += Math.round(normalPt * bestRate) - normalPt;
  }

  const percentApplicable = campaigns.filter(c => c.type === 'percent' && amount >= c.amount);
  if (percentApplicable.length > 0) {
    const bestPercent = Math.max(...percentApplicable.map(c => c.rate));
    // 購入金額の○%分が補助（円単位）なので、同様の理由で
    // 「amount * (bestPercent / 100)」ではなく「amount * bestPercent」を
    // 先に計算してから100で割り、さらに÷10してptに変換する
    campaignBonus += Math.floor((amount * bestPercent) / 100 / 10);
  }

  const total = normalPt + servicePt + campaignBonus;
  return { normalPt, servicePt, campaignBonus, total };
}

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
        for (const c of items) lines.push(`・${formatCampaignDisplay(c)}`);
      }
    }
    lines.push('');
  });
  return lines.join('\n').trim();
}

// ─── エントリポイント ─────────────────────────────────────────────

async function checkSupport() {
  _shouldStop = false;
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
      if (_shouldStop) {
        console.log('[STOP] 停止要求により中断');
        break;
      }

      const clicked = await clickTargetUserByStringID(page, candidate.stringID);
      if (!clicked) continue;

      const latestMessage = await getLatestUserMessage(page);
      console.log(`[STEP3] ${candidate.userName} の最新メッセージ: "${latestMessage.slice(0, 80)}"`);

      if (!isPointRelatedInquiry(latestMessage)) {
        console.log(`[STEP3] ${candidate.userName}: ポイント関連の問い合わせではない → テンプレート自動判定を試行`);

        let templateId = null;
        try {
          templateId = await matchTemplate(latestMessage);
        } catch (e) {
          console.log(`[TEMPLATE] ${candidate.userName}: テンプレート判定に失敗: ${e.message}`);
        }
        console.log(`[TEMPLATE] ${candidate.userName}: templateId=${templateId}`);

        if (templateId) {
          const templates = JSON.parse(fs.readFileSync(CONTACT_TEMPLATES_PATH, 'utf8')).templates;
          const template = templates.find(t => t.id === templateId);
          if (template) {
            // NOTE: support-checker.jsにはこの画面から実際に返信を送信する
            // UI・セレクターが未調査のため、現時点ではLINE通知のみ行い
            // 実送信は行わない（手動でcontact-checker.js等から対応する）
            await sendLine([
              '【自動返答候補（要手動送信）】',
              `ユーザー：${candidate.userName}`,
              `テンプレート：${template.id}`,
              '---',
              template.response,
              '---',
              '※ support-checker.jsからの自動送信は未実装のため、上記内容で手動対応をお願いします',
            ].join('\n'));
          } else {
            console.log(`[TEMPLATE] ${candidate.userName}: templateId="${templateId}" に一致するテンプレートが見つかりません`);
          }
        }

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

    console.log(SUPPORT_CHECK_TEST_MODE
      ? '[STEP6] mg_mail_edit.phpのtableから本日の配信メール一覧を取得（テストモード：時間制限なし）'
      : '[STEP6] mg_mail_edit.phpのtableから本日8時以降の配信メール一覧を取得');
    await mailPage.waitForSelector('table', { timeout: 10000 });
    const mailRows = await getTodayCampaignRows(mailPage);
    console.log(`[STEP6] 対象件数: ${mailRows.length}件`);
    if (mailRows.length > 0) {
      console.log(`[STEP6] 1行目 送信日時: "${mailRows[0].dateText}"`);
      console.log(`[STEP6] 1行目 本文(先頭100文字): "${(mailRows[0].bodyHtml || '').slice(0, 100)}"`);
    }

    if (mailRows.length === 0) {
      const notFoundMsg = SUPPORT_CHECK_TEST_MODE
        ? '本日のお知らせメールは見つかりませんでした'
        : '本日8時以降のお知らせメールは見つかりませんでした';
      await sendLine(`【キャンペーン解析結果】\nユーザー：${target.userName}\n配信メール数：0件\n${notFoundMsg}`);
      console.log('=== support-checker 完了（対象メールなし） ===');
      return;
    }

    console.log('[STEP7-8] 各メールの本文からキャンペーン内容をClaude APIで解析');
    const mails = [];
    for (let i = 0; i < mailRows.length; i++) {
      const row = mailRows[i];
      const campaigns = await parseCampaignWithClaude(row.bodyHtml);
      console.log(`[CAMPAIGN] メール${i + 1} "${row.title}" (${row.dateText}): ${campaigns.length}件検出`);
      mails.push({ title: row.title || `メール${i + 1}`, campaigns });
    }

    console.log('[STEP9] LINEに解析結果を通知');
    await sendLine(buildResultMessage(target.userName, mails));

    // ─── STEP10-17: ポイント履歴確認・調整 ───────────────────────────
    // 実在ユーザーの所持ポイントを変更する処理を含むため、DRY_RUN=trueの
    // 間はSTEP10（+1加算）を含め一切実行しない
    if (DRY_RUN) {
      console.log('[DRY RUN] ポイント履歴確認・調整処理（STEP10-17）をスキップ');
    } else {
      const allCampaigns = mails.flatMap(m => m.campaigns);
      console.log('[DEBUG] allCampaigns:', JSON.stringify(allCampaigns));

      console.log('[STEP10] ブラウザバックで会員詳細ページに戻る');
      await mailPage.evaluate(() => window.history.back());
      await new Promise(r => setTimeout(r, 2000));
      console.log('[DEBUG] STEP10後のフレームURL:', mainFrame.url());

      console.log('[STEP11] 所持ポイントに1を加算');
      // pointMark: value="1"が+（加算）、value="2"が-（減算）
      // pointOut: 増減量そのものを入力する欄（現在値+1を入れるのではない）
      await mainFrame.click('input[name="pointMark"][value="1"]');
      await mainFrame.fill('input[name="pointOut"]', '1');
      await mainFrame.click('input[name="user_henko"]');
      await new Promise(r => setTimeout(r, 3000));
      console.log('[STEP11] ページ更新待機完了');

      // ポイント増減履歴ページの構造（新規ページ/frame内遷移のどちらか）が
      // 未確認のため、popupイベントの有無で判定しデバッグログを残す
      console.log('[STEP12] 「ポイント増減履歴」を開く');
      console.log('[DEBUG] クリック前フレームURL:', mainFrame.url());
      const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
      await mainFrame.click('input[value="ポイント増減履歴"]');
      const popup = await popupPromise;

      let historyPage;
      if (popup) {
        console.log('[STEP12] 新しいページ(popup)で開かれました:', popup.url());
        await popup.waitForLoadState('networkidle').catch(() => {});
        historyPage = popup;
      } else {
        await new Promise(r => setTimeout(r, 3000));
        console.log('[STEP12] 既存フレーム内で遷移しました:', mainFrame.url());
        historyPage = mainFrame;
      }

      console.log('[STEP13] 「表示」ボタンをクリック');
      await historyPage.click('input[name="search"][value="表示"]');
      await new Promise(r => setTimeout(r, 3000));

      console.log('[STEP14] 当日の銀行振込履歴を取得');
      const bankRows = await historyPage.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('tr'));
        const results = [];
        for (const tr of rows) {
          const cells = Array.from(tr.querySelectorAll('td')).map(td => (td.textContent || '').trim());
          if (cells.length === 0) continue;
          const rowText = cells.join(' | ');
          if (!rowText.includes('銀行振込')) continue;
          results.push({ cells, rowText });
        }
        return results;
      });
      console.log(`[STEP14] 銀行振込行数: ${bankRows.length}`);
      bankRows.forEach((r, i) => console.log(`[DEBUG] 銀行振込行[${i}]: ${r.rowText}`));

      // 実データ形式: "2026/07/06 14:11:22 | 銀行振込 | 315 | 決済 | 決済金額 : 3,000円 | 備考 : | 98216"
      // パイプ区切りで分割し、parts[0]=時間、parts[2]=増減ポイント、
      // parts[4]（"決済金額 : 3,000円"）から決済金額（円）を抽出する
      const parsedBankRows = bankRows.map(r => {
        const parts = r.rowText.split('|').map(s => s.trim());
        const time = parts[0];
        const point = parseInt(parts[2], 10);
        const amountMatch = (parts[4] || '').match(/([\d,]+)円/);
        const amount = amountMatch ? parseInt(amountMatch[1].replace(/,/g, ''), 10) : 0;
        return { time, point, amount, raw: r.rowText };
      }).filter(r => !Number.isNaN(r.point) && r.amount > 0);
      console.log(`[STEP14] 時間・ポイント・金額の抽出成功: ${parsedBankRows.length}件`);

      console.log('[STEP15] ポイント計算と照合（当日の入金合計で判定）');
      // キャンペーン補助（fixed/rate/percent）は入金額の閾値判定を伴うため、
      // 各入金を個別に判定すると同一日の合計では閾値を超えるケースを
      // 取りこぼす。当日の入金合計に対して1回だけ補助を計算し、
      // 通常+サービスポイントの合計と合算した上で実際のポイント合計と比較する
      const totalAmount = parsedBankRows.reduce((sum, r) => sum + r.amount, 0);
      const totalActual = parsedBankRows.reduce((sum, r) => sum + r.point, 0);
      const totalExpected = parsedBankRows.reduce((sum, r) => sum + Math.floor(r.amount / 10) + Math.floor(r.amount * 0.005), 0);
      const campaignBonus = calcExpectedPoints(totalAmount, allCampaigns).campaignBonus;
      const grandTotal = totalExpected + campaignBonus;
      const diff = totalActual - grandTotal;
      console.log(`[STEP15] 入金合計=${totalAmount}円 期待値合計=${grandTotal}pt（通常+サービス${totalExpected}+補助${campaignBonus}） 実際合計=${totalActual}pt 差異=${diff}`);

      if (diff === 0) {
        console.log('[STEP15] 一致 → 問題なし');
      } else {
        const diffLabel = diff < 0 ? '不足' : '過剰';
        const diffAbs = Math.abs(diff);

        console.log('[STEP16] 差異ありのためLINEに確認通知');
        await sendLine(`【ポイント確認】
ユーザー：${target.userName}
入金合計：${formatNumber(totalAmount)}円
期待ポイント合計：${grandTotal}pt
実際のポイント合計：${totalActual}pt
差異：${diffAbs}pt（${diffLabel}）
調整しますか？「調整する」または「スキップ」`);

        let reply = null;
        try {
          reply = await waitForLineReply();
        } catch (e) {
          console.log('[STEP16] LINE返信待ちタイムアウト → スキップ扱い:', e.message);
        }

        if (reply === '調整する') {
          console.log(`[STEP16] LINE返信: ${reply}`);
          console.log('[STEP17] 会員詳細ページに戻りポイントを調整');
          if (historyPage !== mainFrame) {
            await historyPage.close().catch(() => {});
          } else {
            await mainFrame.evaluate(() => window.history.back());
            await new Promise(r => setTimeout(r, 2000));
          }

          const sign = diff < 0 ? '+' : '-';
          // pointMark: value="1"が+（加算）、value="2"が-（減算・要確認）
          const pointMarkValue = sign === '+' ? '1' : '2';
          console.log(`[STEP17] ${sign}${diffAbs}pt を調整（pointMark value=${pointMarkValue}）`);
          await mainFrame.click(`input[name="pointMark"][value="${pointMarkValue}"]`);
          await mainFrame.fill('input[name="pointOut"]', String(diffAbs));
          await mainFrame.click('input[name="user_henko"]');
          await new Promise(r => setTimeout(r, 3000));
          await sendLine(`【調整完了】${target.userName}のポイントを${sign}${diffAbs}pt調整しました`);
        } else if (reply !== null) {
          console.log(`[STEP16] LINE返信: ${reply}`);
          console.log('[STEP16] スキップが選択されました');
        }
      }
    }

    console.log('=== support-checker 完了 ===');
  } catch (err) {
    console.error('[FATAL]', err.message, err.stack);
    await sendLine(`【システムエラー】support-checker: ${err.message}`);
  } finally {
    await browser.close();
  }
}

function stopSupport() {
  _shouldStop = true;
  console.log('=== support-checker 停止要求 ===');
}

if (require.main === module) {
  checkSupport();
}

module.exports = { checkSupport, stopSupport };

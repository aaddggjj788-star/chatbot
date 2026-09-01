'use strict';

/**
 * utils.js
 * contact-checker.js / support-checker.js から共通で使う会員詳細ページ操作関数
 *
 * 配置場所: /root/rune-bot/utils.js
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ─── キャンペーンコメントアウトの参照先 ───────────────────────────────
// お知らせメール本文に埋め込まれた <!--week/campaign/3--> 形式の
// コメントアウトから、campaign-rules/campaign1.json の内容を引く
const CAMPAIGN_RULES_PATH = path.join(__dirname, 'campaign-rules', 'campaign1.json');
const CAMPAIGN_COMMENT_RE = /<!--(week|k_id|kanteisi)\/campaign\/(\d+)-->/;

let _campaignRulesCache = null;

function loadCampaignRules() {
  if (_campaignRulesCache) return _campaignRulesCache;
  try {
    _campaignRulesCache = JSON.parse(fs.readFileSync(CAMPAIGN_RULES_PATH, 'utf8'));
  } catch (e) {
    console.log(`[UTILS] campaign1.jsonの読み込みに失敗: ${e.message}`);
    _campaignRulesCache = {};
  }
  return _campaignRulesCache;
}

// type（week / k_id / kanteisi）と番号からcampaign1.jsonの定義を取得する
// 該当が無い場合はnullを返す
function getCampaignInfo(type, number) {
  if (!type || number == null) return null;
  const rules = loadCampaignRules();
  const entry = rules?.[type]?.[String(number)];
  return entry || null;
}

// キャンペーン定義を通知用の1行テキストにする（未検出・未定義はnullを返す）
function formatCampaignInfo(campaign) {
  if (!campaign) return null;
  const info = getCampaignInfo(campaign.type, campaign.number);
  if (!info) return null;
  return [info.name, info.description].filter(Boolean).join(' / ') || null;
}

/**
 * 会員詳細ページを開く共通関数
 * コンタクトメール画面・返信補助画面どちらのリンクにも対応
 */
async function openKyouseitaikai(page, uid) {
  const kyouseiPage = await page.context().newPage();
  await kyouseiPage.goto(`http://manager.x7j4l2p9m1.com/mg/mg_kyoseitaikai.php?ken=1&ken_id=${uid}`);
  await kyouseiPage.waitForLoadState('networkidle');
  console.log(`[UTILS] openKyouseitaikai後のURL: ${kyouseiPage.url()}`);
  return kyouseiPage;
}

/**
 * 会員検索画面から会員詳細ページを開く共通関数
 * mg_kyoseitaikai_list.php でIDを検索し、検索結果のIDリンクをクリックして遷移する
 * （mg_kyoseitaikai.php を直接URL指定で開けない場合に使用する）
 */
async function openKyouseitaikaiBySearch(page, uid) {
  // 新しいページで検索画面を開く
  const searchPage = await page.context().newPage();
  await searchPage.goto('http://manager.x7j4l2p9m1.com/mg/mg_kyoseitaikai_list.php');
  await searchPage.waitForLoadState('networkidle');

  // IDを入力して検索
  await searchPage.fill('textarea[name="ken_id"]', String(uid));
  await searchPage.click('input[name="userSearch"]');
  await searchPage.waitForLoadState('networkidle');

  // 検索結果のIDリンクをクリック
  await searchPage.click(`a[href*="ken_id=${uid}"]`);
  await searchPage.waitForLoadState('networkidle');

  console.log(`[UTILS] openKyouseitaikaiBySearch後のURL: ${searchPage.url()}`);
  return searchPage;
}

/**
 * ポイントを追加/減算する共通関数
 * sign: '+' または '-'
 */
async function adjustPoint(kyouseiPage, amount, sign = '+') {
  console.log(`[UTILS] adjustPoint: sign=${sign} amount=${amount}`);
  const markValue = sign === '+' ? '1' : '2';
  console.log(`[UTILS] adjustPoint時のURL: ${kyouseiPage.url()}`);
  const el = await kyouseiPage.$('input[name="pointMark"][value="1"]');
  console.log(`[UTILS] pointMark要素: ${el ? '存在' : '存在しない'}`);
  if (!el) {
    const html = await kyouseiPage.content();
    console.log(`[UTILS] ページHTML先頭500文字: ${html.slice(0, 500)}`);
  }
  await kyouseiPage.click(`input[name="pointMark"][value="${markValue}"]`);
  await kyouseiPage.fill('input[name="pointOut"]', String(amount));
  await kyouseiPage.click('input[name="user_henko"]');
  await kyouseiPage.waitForLoadState('networkidle');
}

/**
 * ポイントレベル（割引率）を設定する共通関数
 * level: 10〜17のvalue値
 */
async function setPointLevel(kyouseiPage, level) {
  await kyouseiPage.selectOption('select[name="update[lv]"]', String(level));
  await kyouseiPage.click('input[name="user_henko"]');
  await kyouseiPage.waitForLoadState('networkidle');
}

/**
 * 絆レベルを設定する共通関数
 * mg_charaUserUniqueSetting.php（キャラ別ユーザー設定）を新規ページで開き、
 * select[name="lovelv"] を変更して保存する
 * page: 同一コンテキストのPage（新規ページを開くために使用）
 * charaId: キャラID / level: lovelvのvalue値
 */
async function setLoveLevel(page, uid, charaId, level) {
  const lovePage = await page.context().newPage();
  await lovePage.goto(
    `http://manager.x7j4l2p9m1.com/mg/mg_charaUserUniqueSetting.php?ken=1&cid=${charaId}&uid=${uid}`
  );
  await lovePage.waitForLoadState('networkidle');
  await lovePage.selectOption('select[name="lovelv"]', String(level));
  await lovePage.click('input[name="memo_henko"]');
  await lovePage.waitForLoadState('networkidle');
  await lovePage.close();
}

/**
 * 現在の所持ポイントを取得する共通関数
 * kyouseiPage: 会員詳細ページ（mg_kyoseitaikai.php）
 */
async function getCurrentPoint(kyouseiPage) {
  return await kyouseiPage.evaluate(() => {
    const el = document.querySelector('input[name="update[point]"]');
    return el ? parseInt(el.value) : null;
  });
}

/**
 * 会員基本情報を取得する共通関数
 * kyouseiPage: 会員詳細ページ（mg_kyoseitaikai.php）
 * 取得項目: ニックネーム / 所持ポイント / 会員レベル(sub_lv選択テキスト) /
 *           ポイントレベル(lv選択テキスト) / プロフィール2(prof2選択テキスト) /
 *           非公開メモ1(上部3行のうち「@」を含む行を除外して結合) / 最終購入時間
 */
async function getMemberBasicInfo(kyouseiPage) {
  return await kyouseiPage.evaluate(() => {
    const nickname = document.querySelector('input[name="update[name]"]')?.value || '';
    const currentPoint = document.querySelector('input[name="update[point]"]')?.value || '';
    const subLvSelect = document.querySelector('select[name="update[sub_lv]"]');
    const memberLevel = subLvSelect?.selectedOptions[0]?.textContent?.trim() || '';
    const lvSelect = document.querySelector('select[name="update[lv]"]');
    const pointLevel = lvSelect?.selectedOptions[0]?.textContent?.trim() || '';
    const prof2Select = document.querySelector('select[name="update[prof2]"]');
    const profile2 = prof2Select?.selectedOptions[0]?.textContent?.trim() || '';
    const memoRaw = document.querySelector('textarea[name="update[memo]"]')?.value || '';
    const memoLines = memoRaw.split('\n').slice(0, 3).filter(line => !line.includes('@'));
    const memo = memoLines.join('\n');
    const lastPurchase = document.querySelector('input[name="update[kounyu_go]"]')?.value || '';
    return { nickname, currentPoint, memberLevel, pointLevel, profile2, memo, lastPurchase };
  });
}

/**
 * 現在のポイントレベルを取得する共通関数
 */
async function getPointLevel(kyouseiPage) {
  return await kyouseiPage.evaluate(() => {
    const select = document.querySelector('select[name="update[lv]"]');
    return select ? parseInt(select.value) : null;
  });
}

/**
 * ポイントくじクーポンのレベルを取得する共通関数
 * 会員詳細ページ（mg_kyoseitaikai.php）の select[name="autoLv[116]"] の値を返す
 */
async function getCouponLevel(kyouseiPage) {
  return await kyouseiPage.evaluate(() => {
    const select = document.querySelector('select[name="autoLv[116]"]');
    return select ? parseInt(select.value) : null;
  });
}

// ポイントくじクーポンのレベル → 付与ポイント/必要入金額の対応表
// 当日の購入合計金額が minAmount 以上の場合のみ pt を期待値に加算する
const couponLevelMap = {
  3:  { pt: 300,  minAmount: 5000 },
  4:  { pt: 500,  minAmount: 10000 },
  5:  { pt: 700,  minAmount: 10000 },
  6:  { pt: 1000, minAmount: 15000 },
  57: { pt: 1500, minAmount: 15000 },
  58: { pt: 2000, minAmount: 15000 },
};

/**
 * 割引率チェックと適用フロー
 * campaigns: support-checker.jsで取得したキャンペーン情報
 * totalAmount: 当日の購入累計金額
 * uid: 会員ID
 * 戻り値: { changed: boolean, fromLevel?, toLevel? }
 */
async function checkAndApplyDiscount(page, uid, campaigns, totalAmount, sendLine, waitForLineReply, DRY_RUN) {
  // 割引キャンペーンを取得
  const discountCampaigns = campaigns.filter(c => c.type === 'discount' && totalAmount >= c.amount);
  if (discountCampaigns.length === 0) return { changed: false };

  const bestDiscount = Math.max(...discountCampaigns.map(c => c.discount));

  // 割引ptからポイントレベルのvalue値を決定
  // ポイントレベルは送信コストpt（通常150pt）の表記のため、
  // 割引pt数ではなく「150 - 割引pt = 送信コストpt」に対応するレベルで引く
  const discountToLevel = {
    30: 10,   // 30pt割引 → 送信120pt
    50: 11,   // 50pt割引 → 送信100pt
    75: 12,   // 75pt割引 → 送信75pt
    100: 13,  // 100pt割引 → 送信50pt
    120: 14,  // 120pt割引 → 送信30pt
    125: 15,  // 125pt割引 → 送信25pt
    140: 16,  // 140pt割引 → 送信10pt
    149: 17,  // 149pt割引 → 送信1pt
  };
  const targetLevel = discountToLevel[bestDiscount];
  if (!targetLevel) return { changed: false };

  // 会員詳細ページを開いて現在のレベルを確認
  const kyouseiPage = await openKyouseitaikai(page, uid);
  const currentLevel = await getPointLevel(kyouseiPage);

  if (currentLevel === targetLevel) {
    console.log(`[DISCOUNT] uid=${uid}: 既に正しい割引レベル(${targetLevel})が適用済み`);
    await kyouseiPage.close();
    return { changed: false };
  }

  // LINEに確認通知
  await sendLine(
    `【割引率確認】\n会員ID：${uid}\n` +
    `現在のレベル：${currentLevel}\n` +
    `適用すべき割引：${bestDiscount}pt（レベル${targetLevel}）\n` +
    `累計入金：${totalAmount}円\n` +
    `レベルを変更しますか？「変更する」または「スキップ」`
  );

  const reply = await waitForLineReply();
  if (reply === '変更する' && !DRY_RUN) {
    await setPointLevel(kyouseiPage, targetLevel);
    await sendLine(`【割引率変更完了】uid=${uid} レベル${currentLevel}→${targetLevel}（${bestDiscount}pt割引）`);
    await kyouseiPage.close();
    return { changed: true, fromLevel: currentLevel, toLevel: targetLevel };
  }

  await kyouseiPage.close();
  return { changed: false };
}

// ─── 入金額から期待ポイントを計算する（support-checker.js から移動） ───────
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
function calcExpectedPoints(amount, campaigns) {
  const normalPt = Math.floor(amount / 10);
  const servicePt = Math.floor(amount * 0.005);

  let campaignBonus = 0;

  const fixedApplicable = campaigns.filter(c => c.type === 'fixed' && amount >= c.amount);
  if (fixedApplicable.length > 0) {
    campaignBonus += Math.max(...fixedApplicable.map(c => Math.floor(c.bonus / 10)));
  }

  const rateApplicable = campaigns.filter(c => c.type === 'rate' && amount >= c.amount);
  if (rateApplicable.length > 0) {
    const bestRate = Math.max(...rateApplicable.map(c => c.rate));
    campaignBonus += Math.round(normalPt * bestRate) - normalPt;
  }

  const percentApplicable = campaigns.filter(c => c.type === 'percent' && amount >= c.amount);
  if (percentApplicable.length > 0) {
    const bestPercent = Math.max(...percentApplicable.map(c => c.rate));
    campaignBonus += Math.floor((amount * bestPercent) / 100 / 10);
  }

  const total = normalPt + servicePt + campaignBonus;
  return { normalPt, servicePt, campaignBonus, total };
}

// ─── お知らせメール一覧テーブルから本日8:00以降の行を取得 ────────────
// （support-checker.js の getTodayCampaignRows と同じロジック）
// target: Page または Frame（.evaluate()を持つオブジェクト）
async function getTodayCampaignRows(target, testMode = false) {
  const { matched, debugRows, hiddenCount } = await target.evaluate((testMode) => {
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

    const candidateRows = Array.from(document.querySelectorAll('tr'))
      .filter(tr => tr.querySelector('input[value="HTMLメールとしてみる"]'));

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

    // 「ユーザー削除済」か「非表示指定」か「緊急停止・削除」のため非表示
    // と表示されている行は本文を取得できないため除外する
    function isHiddenRow(cells) {
      return cells.some(td => {
        const text = (td.textContent || '').replace(/\s+/g, '');
        return text.includes('のため非表示')
          && (text.includes('ユーザー削除済') || text.includes('非表示指定') || text.includes('緊急停止・削除'));
      });
    }

    // td.bodyNaibu のテキストを取得する。コメントアウトが実体参照として
    // 文字列表示されている場合はtextContent、実際のコメントノードとして
    // 存在する場合はinnerHTML側に現れるため両方を連結して返す
    function extractBodyNaibu(tr) {
      const els = Array.from(tr.querySelectorAll('td.bodyNaibu, .bodyNaibu'));
      if (els.length === 0) return '';
      return els.map(el => `${el.textContent || ''}\n${el.innerHTML || ''}`).join('\n');
    }

    const debugRows = [];
    const matched = [];
    let hiddenCount = 0;

    for (const tr of candidateRows) {
      const cells = Array.from(tr.querySelectorAll('td'));
      const dateCellText = cells[2] ? (cells[2].textContent || '').trim() : '';
      const parsed = parseDateCell(dateCellText);
      debugRows.push({ dateCellText, parsed });

      if (isHiddenRow(cells)) {
        hiddenCount++;
        continue;
      }

      if (!parsed) continue;
      const isToday = parsed.month === nowMonth && parsed.day === nowDay;
      const isAfter8 = testMode ? true : (parsed.hour * 60 + parsed.minute) >= 8 * 60;
      if (!isToday || !isAfter8) continue;

      const htmlButton = tr.querySelector('input[value="HTMLメールとしてみる"]');
      const body = extractBody(tr, htmlButton);

      const title = cells[3] ? (cells[3].textContent || '').trim() : '';
      const bodyNaibuText = extractBodyNaibu(tr);

      matched.push({
        dateText: dateCellText, title,
        bodyHtml: body.value, bodySource: body.source,
        bodyNaibuText,
      });
    }

    return { matched, debugRows, hiddenCount };
  }, testMode);

  // キャンペーンコメントアウト（<!--week/campaign/3--> 等）をNode側で解析する
  // ※ページ内評価の戻り値にRegExp結果を含められないためここで判定する
  for (const row of matched) {
    const m = (row.bodyNaibuText || '').match(CAMPAIGN_COMMENT_RE);
    row.campaign = m ? { type: m[1], number: parseInt(m[2], 10) } : null;
    if (row.campaign) {
      console.log(`[UTILS] キャンペーンコメントアウト検出: ${row.campaign.type}/campaign/${row.campaign.number}（"${row.title}"）`);
    }
  }

  console.log(`[UTILS] 「HTMLメールとしてみる」保有行: ${debugRows.length}件 / 非表示除外: ${hiddenCount}件 / 本日該当: ${matched.length}件`);
  return matched;
}

// ─── STEP4-6相当: 会員詳細ページから「お知らせメッセージ編集」をクリックし ──
// mg_mail_edit.phpへ遷移して当日配信メールを取得する
// target: 会員詳細ページ（Page または Frame）
async function getMailRows(target, testMode = false) {
  await target.waitForSelector('input[name="info_mess"]', { timeout: 10000 });
  console.log('[UTILS] 「お知らせメッセージ編集」ボタンをクリック');
  await target.click('input[name="info_mess"]');
  await new Promise(r => setTimeout(r, 3000));

  const currentUrl = target.url();
  console.log('[UTILS] 遷移後URL:', currentUrl);
  if (!currentUrl.includes('mg_mail_edit')) {
    console.log('[UTILS] mg_mail_edit.phpへの遷移が確認できませんでした');
    return [];
  }

  await target.waitForSelector('table', { timeout: 10000 });
  const mailRows = await getTodayCampaignRows(target, testMode);
  console.log(`[UTILS] 当日配信メール取得: ${mailRows.length}件`);
  return mailRows;
}

// ─── STEP10-14相当: 会員詳細ページに戻り、 ────────────────────────
// ポイント増減履歴から当日の銀行振込履歴を取得する
// topPage: popupイベント検知用の最上位Page（Frameはwaitで使えないため必須）
// target: クリック対象（Page または Frame。mg_mail_edit.phpから戻る操作もここで行う）
// 戻り値: { paymentRows, actionRows, manualRows, historyPage, couponLevel }
//   ポイント増減履歴ページの各行を背景色で分類して全件取得する：
//     payment(#ccffcc)=決済 / action(#ccccff)=行動履歴 / manual(#ffcccc)=手動操作
//   historyPageはSTEP17の調整操作で使う（popupで開いた場合はtargetと異なる
//   オブジェクトになるため呼び出し側でclose/戻る操作を行い分ける必要がある）
// ※以前は履歴表示前に所持ポイントを+1していたが、参照のみのはずの処理で
//   会員のポイントが増えてしまうため削除した
// ─── 「ポイント増減履歴」ページの日付検索フォーム（前日以前へ遡るための設定）──
// 始点(始点=[0])の年/月/日/時/分を指定して「表示」すると、始点〜終点(=当日)の
// 範囲の履歴が表示される。終点[1]は当日のままにし、始点[0]の日(必要なら月)を
// 遡らせることで過去数日分をまとめて取得する。
// 始点の入力欄が存在しない場合は遡り検索を行わず、決済前ポイントの取得失敗として
// 通知する（当日内で解決できる場合はそのまま動作）。
const HISTORY_SEARCH = {
  startYear:  process.env.SEL_HISTORY_START_YEAR  || 'input[name="in_year[0]"]',
  startMonth: process.env.SEL_HISTORY_START_MONTH || 'input[name="in_month[0]"]',
  startDay:   process.env.SEL_HISTORY_START_DAY   || 'input[name="in_day[0]"]',
  startHour:  process.env.SEL_HISTORY_START_HOUR  || 'input[name="in_toki[0]"]',
  startMin:   process.env.SEL_HISTORY_START_MIN   || 'input[name="in_hun[0]"]',
  showButton: process.env.SEL_HISTORY_SHOW        || 'input[name="search"][value="表示"]',
  daysBack:   parseInt(process.env.HISTORY_DAYS_BACK || '5', 10), // 最大何日前まで遡るか
};

// 履歴行の増減ポイント（符号付き。cells[2]）
function historyRowDelta(r) {
  const m = String(r.cells[2] || '').match(/-?[\d,]+/);
  return m ? parseInt(m[0].replace(/,/g, ''), 10) : 0;
}
// 履歴行の「変更後ポイント（残高）」。manual行のみ確定値を持つ（cells[5]）。他はnull。
function historyRowAfter(r) {
  if (r.type !== 'manual') return null;
  const s = String(r.cells[5] || '').replace(/[^\d-]/g, '');
  if (s === '' || s === '-') return null;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}
// 当日(JST)の年月日を取得する
function jstToday() {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }); // YYYY-MM-DD
  const [y, mo, d] = s.split('-').map(Number);
  return { y, mo, d };
}
// 履歴行のcells[0]から日時をパースしてタイムスタンプ(ms)に変換する。
// 日付が無い(時刻のみ)場合は defYmd(既定=当日)を用いる。複数日を跨ぐ範囲取得時に
// 行の前後関係を正しく判定するために使用する。
function historyRowTs(r, defYmd) {
  const str = String(r.time || '');
  const t = str.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const hh = t ? +t[1] : 0, mm = t ? +t[2] : 0, ss = t ? +(t[3] || 0) : 0;
  let y = defYmd.y, mo = defYmd.mo, d = defYmd.d;
  const dFull = str.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (dFull) {
    y = +dFull[1]; mo = +dFull[2]; d = +dFull[3];
  } else {
    const dMd = str.match(/(?:^|[^\d])(\d{1,2})[\/\-.](\d{1,2})(?=[^\d]|$)/);
    if (dMd) { mo = +dMd[1]; d = +dMd[2]; }
  }
  return new Date(y, mo - 1, d, hh, mm, ss).getTime();
}
function fmtHistoryDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
// 日付検索フォームが利用可能か（始点の日入力欄の存在で判定）
async function dateSearchAvailable(pg) {
  try { return (await pg.$(HISTORY_SEARCH.startDay)) != null; }
  catch { return false; }
}
// 始点を startDate に設定して（終点=当日のまま）「表示」→ 範囲の履歴を再スクレイプする
async function loadHistoryRange(pg, startDate, scrapeRows) {
  await pg.fill(HISTORY_SEARCH.startYear,  String(startDate.getFullYear())).catch(() => {});
  await pg.fill(HISTORY_SEARCH.startMonth, String(startDate.getMonth() + 1).padStart(2, '0')).catch(() => {});
  await pg.fill(HISTORY_SEARCH.startDay,   String(startDate.getDate()).padStart(2, '0')).catch(() => {});
  await pg.fill(HISTORY_SEARCH.startHour,  '0').catch(() => {});
  await pg.fill(HISTORY_SEARCH.startMin,   '0').catch(() => {});
  await pg.click(HISTORY_SEARCH.showButton);
  await new Promise(r => setTimeout(r, 3000));
  return scrapeRows(pg);
}

// ─── 「追加ポイント確認」用: 決済前ポイントの解決 ─────────────────────
// 1. 当日の最初の決済行(payment)を探す
// 2. 決済行より前の時刻の履歴(action/manual)のうち、決済行に一番近いものの
//    「直後の残高」を決済前ポイントとする（manualはafter値、それ以外は直近manual
//    のafterから以降の増減を積み上げて算出）
// 3. 当日に決済前履歴が無い場合は日付検索で始点を遡らせ（最大 daysBack 日前まで）
//    範囲取得し、決済行より前の履歴から同様に決済前ポイントを求める
//    見つからなければ ok:false を返す
// 戻り値: { ok:true, beforePoint, sourceDate, postRows } | { ok:false, reason } | null(決済なし)
async function resolvePrePaymentBalance(historyPage, todayRawRows, scrapeRows) {
  const today = jstToday();
  const tsOf = (r) => historyRowTs(r, today);
  const isToday = (ts) => {
    const d = new Date(ts);
    return d.getFullYear() === today.y && (d.getMonth() + 1) === today.mo && d.getDate() === today.d;
  };

  // 当日の最初の決済行を rows から取り出す
  function firstPaymentToday(rows) {
    return rows
      .filter(r => r.type === 'payment' && isToday(tsOf(r)))
      .sort((a, b) => tsOf(a) - tsOf(b))[0] || null;
  }

  // targetRow の直後残高。manualならafter、それ以外は ctx 内の直近manual(after確定)を
  // 起点に、以降target時刻までの増減を積み上げる。
  function balanceAfter(ctxOrdered, targetRow) {
    if (targetRow.type === 'manual') {
      const a = historyRowAfter(targetRow);
      if (a != null) return a;
    }
    const tTs = tsOf(targetRow);
    let anchor = null, anchorTs = null;
    for (const r of ctxOrdered) {
      const s = tsOf(r);
      if (r.type === 'manual' && historyRowAfter(r) != null && s <= tTs &&
          (anchorTs == null || s > anchorTs)) {
        anchor = r; anchorTs = s;
      }
    }
    if (!anchor) return null; // 残高を確定できるmanualが無い
    let bal = historyRowAfter(anchor);
    for (const r of ctxOrdered) {
      const s = tsOf(r);
      if (r !== anchor && s > anchorTs && s <= tTs) bal += historyRowDelta(r);
    }
    return bal;
  }

  function buildResult(beforePoint, sourceDate, ordered, firstPayment) {
    const fpTs = tsOf(firstPayment);
    // 決済行以降の当日行（走行残高の再構築用に delta/after を保持）
    const postRows = ordered
      .filter(r => tsOf(r) >= fpTs)
      .map(r => ({ type: r.type, time: r.time, delta: historyRowDelta(r), after: historyRowAfter(r) }));
    return { ok: true, beforePoint, sourceDate, postRows };
  }

  // rows の中から firstPayment 直前の「決済に一番近い履歴」の直後残高を決済前ポイントとする
  function resolveFrom(rows, firstPayment) {
    const ordered = [...rows].sort((a, b) => tsOf(a) - tsOf(b));
    const fpTs = tsOf(firstPayment);
    const prior = ordered.filter(r =>
      r !== firstPayment && (r.type === 'action' || r.type === 'manual') && tsOf(r) < fpTs);
    if (prior.length === 0) return null;
    const closest = prior[prior.length - 1]; // 決済に一番近い（最大時刻）
    const ctx = ordered.filter(r => tsOf(r) <= tsOf(closest));
    const before = balanceAfter(ctx, closest);
    if (before == null) return null;
    const sourceDate = isToday(tsOf(closest)) ? '当日' : fmtHistoryDate(new Date(tsOf(closest)));
    return buildResult(before, sourceDate, ordered, firstPayment);
  }

  const fpToday = firstPaymentToday(todayRawRows);
  if (!fpToday) return null; // 当日決済なし

  // 1) 当日の履歴だけで解決を試みる
  const r1 = resolveFrom(todayRawRows, fpToday);
  if (r1) return r1;

  // 2) 解決できない → 始点を遡らせて範囲取得（終点=当日のまま）し、再度解決を試みる
  if (!(await dateSearchAvailable(historyPage))) {
    console.log('[UTILS] 決済前ポイント: 当日内で解決できず、日付検索フォームも未対応 → 取得失敗');
    return { ok: false, reason: 'date-search-unavailable' };
  }
  const start = new Date(today.y, today.mo - 1, today.d);
  start.setDate(start.getDate() - HISTORY_SEARCH.daysBack);
  let extended = [];
  try {
    extended = await loadHistoryRange(historyPage, start, scrapeRows);
  } catch (e) {
    console.log(`[UTILS] 過去履歴の範囲取得に失敗: ${e.message}`);
  }
  if (extended && extended.length) {
    // 範囲取得後の集合から当日の最初の決済行を取り直す（無ければ当日分を流用）
    const fpExt = firstPaymentToday(extended) || fpToday;
    const r2 = resolveFrom(extended, fpExt);
    if (r2) return r2;
  }
  return { ok: false, reason: 'no-history-5days' };
}

async function getBankHistory(topPage, target, options = {}) {
  const { resolvePrePayment = false } = options;
  console.log(`[UTILS] kyouseiPage URL: ${target.url()}`);

  console.log('[UTILS] ブラウザバックで会員詳細ページに戻る');
  await target.evaluate(() => window.history.back());
  await new Promise(r => setTimeout(r, 2000));

  // 会員詳細ページに戻ったこのタイミングでポイントくじクーポンのLvを取得しておく
  // （この後ポイント増減履歴へ遷移すると autoLv[116] が参照できなくなるため）
  let couponLevel = null;
  try {
    couponLevel = await getCouponLevel(target);
    console.log(`[UTILS] ポイントくじクーポンLv: ${couponLevel}`);
  } catch (e) {
    console.log('[UTILS] ポイントくじクーポンLvの取得に失敗:', e.message);
  }

  console.log(`[UTILS] ポイント増減履歴を開く前のURL: ${target.url()}`);
  console.log('[UTILS] 「ポイント増減履歴」を開く');
  const popupPromise = topPage.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
  await target.click('input[value="ポイント増減履歴"]');
  const popup = await popupPromise;

  let historyPage;
  if (popup) {
    console.log('[UTILS] 新しいページ(popup)で開かれました:', popup.url());
    await popup.waitForLoadState('networkidle').catch(() => {});
    historyPage = popup;
  } else {
    await new Promise(r => setTimeout(r, 3000));
    historyPage = target;
  }

  // 背景色ごとに行種別(payment/action/manual)を判定して全行を取得する共通処理。
  // 背景色はtr/tdのstyle属性・bgcolor属性いずれに付与されていても拾えるよう、
  // 行内の全セル分のスタイル文字列を結合して判定する。
  // 日付検索で表示範囲を変えた後の再取得にも使えるよう関数化する。
  async function scrapeRows(pg) {
    return pg.evaluate(() => {
      function rowStyleText(tr) {
        let s = (tr.getAttribute('style') || '') + ' ' + (tr.getAttribute('bgcolor') || '');
        for (const td of tr.querySelectorAll('td')) {
          s += ' ' + (td.getAttribute('style') || '') + ' ' + (td.getAttribute('bgcolor') || '');
        }
        return s.toLowerCase();
      }
      const rows = Array.from(document.querySelectorAll('tr'));
      const results = [];
      for (const tr of rows) {
        const cells = Array.from(tr.querySelectorAll('td')).map(td => (td.textContent || '').trim());
        if (cells.length === 0) continue;
        const style = rowStyleText(tr);
        let type = null;
        if (style.includes('ccffcc')) type = 'payment';       // 決済
        else if (style.includes('ccccff')) type = 'action';    // 行動履歴
        else if (style.includes('ffcccc')) type = 'manual';    // 手動操作
        if (!type) continue;
        results.push({ type, cells, time: cells[0] });
      }
      return results;
    });
  }

  console.log('[UTILS] 「表示」ボタンをクリック');
  await historyPage.click('input[name="search"][value="表示"]');
  await new Promise(r => setTimeout(r, 3000));

  const allRows = await scrapeRows(historyPage);

  // 「+1,115」「-500」などの符号付き数値文字列を整数へ変換する
  function parseSignedInt(s) {
    const m = String(s || '').match(/-?[\d,]+/);
    return m ? parseInt(m[0].replace(/,/g, ''), 10) : 0;
  }

  // ── payment（決済）: 従来のbankRowsと同じ形（time/point/amount/isBankTransfer/raw）──
  const paymentRows = allRows
    .filter(r => r.type === 'payment')
    .map(r => {
      const c = r.cells;
      const point = parseInt(c[2], 10);
      const amountMatch = (c[4] || '').match(/決済金額\s*[:：]\s*([\d,]+)円/);
      const amount = amountMatch ? parseInt(amountMatch[1].replace(/,/g, ''), 10) : 0;
      const isBankTransfer = c[3] === '銀行振込' || (c[4] || '').includes('銀行振込');
      return { time: c[0], point, amount, isBankTransfer, raw: c.join(' | ') };
    })
    .filter(r => !Number.isNaN(r.point) && r.amount > 0);

  // ── action（行動履歴）: メッセージ送信等。pointはマイナス値の場合あり ──
  const actionRows = allRows
    .filter(r => r.type === 'action')
    .map(r => {
      const c = r.cells;
      return {
        time: c[0],
        actionName: c[1] || '',
        point: parseInt(c[2], 10) || 0,
        target: c[3] || '',
        raw: c.join(' | '),
      };
    });

  // ── manual（手動操作）: 会員プロフィール変更・管理者によるポイント調整等 ──
  const manualRows = allRows
    .filter(r => r.type === 'manual')
    .map(r => {
      const c = r.cells;
      return {
        time: c[0],
        actionName: c[1] || '',
        pointChange: parseSignedInt(c[2]),
        before: c[4] || '',
        after: c[5] || '',
        note: c[6] || '',
        raw: c.join(' | '),
      };
    });

  console.log(`[UTILS] ポイント増減履歴取得: 決済${paymentRows.length}件 / 行動履歴${actionRows.length}件 / 手動操作${manualRows.length}件`);

  // 「追加ポイント確認」用の決済前ポイント解決（resolvePrePayment=true かつ決済ありのとき）。
  // ※日付検索で前日以降へ遷移する可能性があるため、当日表示を前提とする他フローに
  //   影響しないよう既定では実行しない（呼び出し側が明示的にtrueを渡す）。
  let prePayment = null;
  if (resolvePrePayment && paymentRows.length > 0) {
    try {
      prePayment = await resolvePrePaymentBalance(historyPage, allRows, scrapeRows);
    } catch (e) {
      console.log('[UTILS] 決済前ポイント解決に失敗:', e.message);
      prePayment = { ok: false, reason: `error: ${e.message}` };
    }
  }

  return { paymentRows, actionRows, manualRows, historyPage, couponLevel, prePayment };
}

// ─── STEP15相当: ポイント差異チェック ─────────────────────────────
// 期待ポイントと実際のポイントを照合し、差異があればLINEに確認通知して
// 返信を待つ。実際の調整（adjustPoint呼び出し）は呼び出し側で行う。
// paymentRows: 決済行（getBankHistoryのpaymentRows。従来のbankRows）
//   → 期待値計算・差異判定は従来どおり決済行のみで行う
// actionRows / manualRows: 行動履歴・手動操作の増減行（getBankHistoryの戻り値）
//   → 当日の実際のポイント純変動（netChange）を算出し、現在ポイントとの
//     照合に使えるよう合計値を通知・戻り値に含める
// prePayment: getBankHistory({resolvePrePayment:true})の戻り値（決済前ポイント解決結果）
//   → { ok:true, beforePoint, sourceDate, postRows } の場合は「追加ポイント確認」方式
//     （決済前ポイントと決済後最大ポイントの差＝実際に増えたポイント）で通知する。
//   → { ok:false } の場合は取得失敗として通知して中断する。
//   → null の場合は従来どおり決済行ベースの差異判定を行う。
async function checkPointDiff(campaigns, paymentRows, sendLine, waitForLineReply, DRY_RUN, couponLevel = null, actionRows = [], manualRows = [], prePayment = null) {
  const totalAmount = paymentRows.reduce((sum, r) => sum + r.amount, 0);
  const totalActual = paymentRows.reduce((sum, r) => sum + r.point, 0);
  const normalPt = paymentRows.reduce((sum, r) => sum + Math.floor(r.amount / 10), 0);
  const servicePt = paymentRows.reduce(
    (sum, r) => sum + (r.isBankTransfer ? Math.floor(r.amount * 0.005) : 0), 0);
  const campaignBonus = calcExpectedPoints(totalAmount, campaigns).campaignBonus;

  // 決済以外の当日ポイント変動も集計する
  // ・行動履歴（メッセージ送信等）: pointはマイナス値になりうる
  // ・手動操作（管理者による調整等）: pointChangeは符号付き
  const actionTotal = actionRows.reduce((sum, r) => sum + (r.point || 0), 0);
  const manualTotal = manualRows.reduce((sum, r) => sum + (r.pointChange || 0), 0);

  // ポイントくじクーポン: 当日の購入合計金額が minAmount 以上なら期待値に加算する
  let couponPt = 0;
  const couponInfo = couponLevel != null ? couponLevelMap[couponLevel] : null;
  if (couponInfo && totalAmount >= couponInfo.minAmount) {
    couponPt = couponInfo.pt;
  }

  const grandTotal = normalPt + servicePt + campaignBonus + couponPt;
  const diff = totalActual - grandTotal;
  // 当日の実際のポイント純変動（決済＋行動履歴＋手動操作）
  const netChange = totalActual + actionTotal + manualTotal;
  console.log(`[UTILS] 入金合計=${totalAmount}円 期待値合計=${grandTotal}pt（通常${normalPt}+サービス${servicePt}+補助${campaignBonus}+くじクーポン${couponPt}(Lv.${couponLevel}）） 決済実績=${totalActual}pt 差異=${diff} / 行動履歴計=${actionTotal}pt 手動操作計=${manualTotal}pt 純変動=${netChange}pt`);

  // ─── 「追加ポイント確認」方式（prePaymentが渡された場合）────────────────
  // 決済前ポイントの取得に失敗 → エラー通知して中断
  if (prePayment && prePayment.ok === false) {
    console.log(`[UTILS] 決済前ポイント取得失敗（reason=${prePayment.reason}） → 追加ポイント確認を中断`);
    await sendLine(
      `【エラー】決済前ポイントの取得に失敗しました\n` +
      `5日以内に履歴が見つかりませんでした\n` +
      `手動で確認をお願いします`
    );
    // 自動調整が走らないよう diff:0・reply:null を返す
    return { totalAmount, totalActual, grandTotal, couponPt, couponLevel, diff: 0, reply: null, actionTotal, manualTotal, netChange, prePaymentError: prePayment.reason };
  }

  // 決済前ポイントが解決できた → 決済後の最大ポイントとの差で「実際に増えたポイント」を算出
  if (prePayment && prePayment.ok) {
    const beforePoint = prePayment.beforePoint;
    // 決済前ポイントを起点に、決済行以降の当日行を時系列で適用して走行残高を再構築する。
    // manual行はafter(残高確定値)にスナップ、それ以外は増減(delta)を加算する。
    let bal = beforePoint;
    let maxPoint = beforePoint;
    for (const r of prePayment.postRows || []) {
      if (r.after != null) bal = r.after;
      else bal += (r.delta || 0);
      if (bal > maxPoint) maxPoint = bal;
    }
    const actualIncrease = maxPoint - beforePoint;
    const addDiff = actualIncrease - grandTotal; // 実際に増えたポイント − 期待ポイント
    console.log(`[UTILS] 追加ポイント確認: 決済前=${beforePoint}pt(${prePayment.sourceDate}) 決済後最大=${maxPoint}pt 実増=${actualIncrease}pt 期待=${grandTotal}pt 差異=${addDiff}pt`);

    await sendLine(
      `【ポイント確認（追加）】\n` +
      `決済前ポイント：${beforePoint}pt（${prePayment.sourceDate}時点）\n` +
      `決済後の最大ポイント：${maxPoint}pt\n` +
      `実際に増えたポイント：${actualIncrease}pt\n` +
      `入金合計：${totalAmount.toLocaleString('en-US')}円\n` +
      `期待ポイント：${grandTotal}pt\n` +
      `差異：${addDiff}pt\n` +
      `調整しますか？「調整する」または「スキップ」`
    );

    let reply = null;
    try {
      reply = await waitForLineReply();
    } catch (e) {
      console.log('[UTILS] LINE返信待ちタイムアウト → スキップ扱い:', e.message);
    }
    if (reply !== null) console.log(`[UTILS] LINE返信: ${reply}`);

    // diff は addDiff（実増−期待）を返す。呼び出し側(STEP17)は diff<0→加算 / diff>0→減算。
    return { totalAmount, totalActual, grandTotal, couponPt, couponLevel, diff: addDiff, reply, actionTotal, manualTotal, netChange, beforePoint, maxPoint, actualIncrease, prePaymentDate: prePayment.sourceDate };
  }

  if (diff === 0) {
    console.log('[UTILS] 一致 → 問題なし');
    return { totalAmount, totalActual, grandTotal, couponPt, couponLevel, diff: 0, reply: null, actionTotal, manualTotal, netChange };
  }

  const diffLabel = diff < 0 ? '不足' : '過剰';
  const diffAbs = Math.abs(diff);

  await sendLine(
    `【ポイント確認】\n` +
    `入金合計：${totalAmount.toLocaleString('en-US')}円\n` +
    `通常付与：${normalPt}pt\n` +
    `サービスpt：${servicePt}pt\n` +
    `キャンペーン補助：${campaignBonus}pt\n` +
    `くじクーポン：${couponPt}pt（Lv.${couponLevel != null ? couponLevel : '-'}）\n` +
    `期待ポイント合計：${grandTotal}pt\n` +
    `決済による付与：${totalActual}pt\n` +
    (actionRows.length > 0 ? `行動履歴による増減：${actionTotal}pt（${actionRows.length}件）\n` : '') +
    (manualRows.length > 0 ? `手動操作による増減：${manualTotal}pt（${manualRows.length}件）\n` : '') +
    `差異：${diffAbs}pt（${diffLabel}）\n` +
    `調整しますか？「調整する」または「スキップ」`
  );

  let reply = null;
  try {
    reply = await waitForLineReply();
  } catch (e) {
    console.log('[UTILS] LINE返信待ちタイムアウト → スキップ扱い:', e.message);
  }

  if (reply !== null) console.log(`[UTILS] LINE返信: ${reply}`);

  return { totalAmount, totalActual, grandTotal, couponPt, couponLevel, diff, reply, actionTotal, manualTotal, netChange };
}

// ─── 入金処理（ポイント追加）─────────────────────────────────────────
// mail-checker.js の addPointsViaPlaywright（銀行入金メール検知時の処理）を
// 移動したもの。会員IDと入金額から会員詳細ページを直接開き、ポイント追加
// フォームを操作する。自前でブラウザを起動・ログインするため、Page不要で
// 単独実行できる（mail-checker.js / server.js / contact-checker.js /
// support-checker.js から共通で使用する）。
// ※ログインフォームのセレクター/認証情報は mail-checker.js と同一のものを
//   使用する（他のチェッカーの login() とはセレクターが異なる点に注意）

// プルダウンに存在するプリセット金額（円）
const PRESET_AMOUNTS = [1000, 1500, 3000, 5000, 10000, 15000, 20000, 30000, 50000, 70000, 100000];

// ポイント計算: 入金額÷10 + 入金額×0.5%（端数切り捨て）
function calcPaymentPoints(amount) {
  return Math.floor(amount / 10 + amount * 0.005);
}

async function processPayment(memberId, amount, points) {
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
    console.log('[PAYMENT] ページタイトル:', await page.title());

    // ── セッション切れページの検知・回避 ──
    const sessionLink = page.locator('a[href*="s_system"]');
    if (await sessionLink.count() > 0) {
      console.log('[PAYMENT] セッション切れページを検知 → リンクをクリックしてログインページへ遷移');
      await sessionLink.first().click();
      await page.waitForLoadState('networkidle');
    }

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
    await frame.click('input[name="point_bg1"]');
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

// ─── 手動入金コマンド共通処理 ─────────────────────────────────────────
// 「{uid} {金額}円 入金」コマンドの実処理。ポイントを計算して processPayment で
// 追加し、完了/エラーを sendLine で通知する（server.js / contact-checker.js /
// support-checker.js から共通で使用）。
// sendLine: 通知関数（各ファイルの sendLine / lineBroadcast を渡す）
async function runPaymentCommand(uid, amount, sendLine, DRY_RUN = false) {
  const points = calcPaymentPoints(amount);
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  console.log(`[PAYMENT-CMD] uid=${uid} 入金額=${amount}円 → ${points}pt`);

  if (DRY_RUN) {
    console.log(`[DRY RUN] uid=${uid}: 入金処理(${amount}円 → ${points}pt)をスキップ`);
    await sendLine(`【DRY RUN】入金処理をスキップしました\n会員ID：${uid}\n入金額：${amount}円`);
    return;
  }

  try {
    await processPayment(uid, amount, points);
    await sendLine(`【入金処理完了】\n会員ID：${uid}\n入金額：${amount}円\n処理日時：${now}`);
  } catch (err) {
    console.error(`[PAYMENT-CMD] uid=${uid}: 入金処理に失敗:`, err.message);
    await sendLine(`【入金処理エラー】\n会員ID：${uid}\n入金額：${amount}円\nエラー：${err.message}`);
  }
}

module.exports = {
  openKyouseitaikai, openKyouseitaikaiBySearch,
  adjustPoint, setPointLevel, getPointLevel, getCouponLevel, getCurrentPoint, getMemberBasicInfo, setLoveLevel,
  checkAndApplyDiscount,
  calcExpectedPoints, getTodayCampaignRows, getMailRows, getBankHistory, checkPointDiff,
  getCampaignInfo, formatCampaignInfo,
  calcPaymentPoints, processPayment, runPaymentCommand,
};

'use strict';

/**
 * utils.js
 * contact-checker.js / support-checker.js から共通で使う会員詳細ページ操作関数
 *
 * 配置場所: /root/rune-bot/utils.js
 */

/**
 * 会員詳細ページを開く共通関数
 * コンタクトメール画面・返信補助画面どちらのリンクにも対応
 */
async function openKyouseitaikai(page, uid) {
  const kyouseiPage = await page.context().newPage();
  await kyouseiPage.goto(`http://manager.x7j4l2p9m1.com/mg/mg_kyoseitaikai.php?ken=1&ken_id=${uid}`);
  await kyouseiPage.waitForLoadState('networkidle');
  return kyouseiPage;
}

/**
 * ポイントを追加/減算する共通関数
 * sign: '+' または '-'
 */
async function adjustPoint(kyouseiPage, amount, sign = '+') {
  console.log(`[UTILS] adjustPoint: sign=${sign} amount=${amount}`);
  const markValue = sign === '+' ? '1' : '2';
  const el = await kyouseiPage.$('input[name="pointMark"][value="1"]');
  console.log(`[UTILS] pointMark要素: ${el ? '存在' : '存在しない'}`);
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
 * 現在のポイントレベルを取得する共通関数
 */
async function getPointLevel(kyouseiPage) {
  return await kyouseiPage.evaluate(() => {
    const select = document.querySelector('select[name="update[lv]"]');
    return select ? parseInt(select.value) : null;
  });
}

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
  const { matched, debugRows } = await target.evaluate((testMode) => {
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

    const debugRows = [];
    const matched = [];

    for (const tr of candidateRows) {
      const cells = Array.from(tr.querySelectorAll('td'));
      const dateCellText = cells[2] ? (cells[2].textContent || '').trim() : '';
      const parsed = parseDateCell(dateCellText);
      debugRows.push({ dateCellText, parsed });

      if (!parsed) continue;
      const isToday = parsed.month === nowMonth && parsed.day === nowDay;
      const isAfter8 = testMode ? true : (parsed.hour * 60 + parsed.minute) >= 8 * 60;
      if (!isToday || !isAfter8) continue;

      const htmlButton = tr.querySelector('input[value="HTMLメールとしてみる"]');
      const body = extractBody(tr, htmlButton);

      const title = cells[3] ? (cells[3].textContent || '').trim() : '';

      matched.push({ dateText: dateCellText, title, bodyHtml: body.value, bodySource: body.source });
    }

    return { matched, debugRows };
  }, testMode);

  console.log(`[UTILS] 「HTMLメールとしてみる」保有行: ${debugRows.length}件 / 本日該当: ${matched.length}件`);
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

// ─── STEP10-14相当: 会員詳細ページに戻り、ポイント+1加算後、 ──────────
// ポイント増減履歴から当日の銀行振込履歴を取得する
// topPage: popupイベント検知用の最上位Page（Frameはwaitで使えないため必須）
// target: クリック対象（Page または Frame。mg_mail_edit.phpから戻る操作もここで行う）
// 戻り値: { bankRows, historyPage } historyPageはSTEP17の調整操作で使う
//   （popupで開いた場合はtargetと異なるオブジェクトになるため呼び出し側で
//   close/戻る操作を行い分ける必要がある）
async function getBankHistory(topPage, target) {
  console.log(`[UTILS] kyouseiPage URL: ${target.url()}`);

  console.log('[UTILS] ブラウザバックで会員詳細ページに戻る');
  await target.evaluate(() => window.history.back());
  await new Promise(r => setTimeout(r, 2000));

  console.log(`[UTILS] adjustPoint前URL: ${target.url()}`);
  console.log('[UTILS] 所持ポイントに1を加算');
  await target.click('input[name="pointMark"][value="1"]');
  await target.fill('input[name="pointOut"]', '1');
  await target.click('input[name="user_henko"]');
  await new Promise(r => setTimeout(r, 3000));

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

  console.log('[UTILS] 「表示」ボタンをクリック');
  await historyPage.click('input[name="search"][value="表示"]');
  await new Promise(r => setTimeout(r, 3000));

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

  const parsedBankRows = bankRows.map(r => {
    const parts = r.rowText.split('|').map(s => s.trim());
    const time = parts[0];
    const point = parseInt(parts[2], 10);
    const amountMatch = (parts[4] || '').match(/([\d,]+)円/);
    const amount = amountMatch ? parseInt(amountMatch[1].replace(/,/g, ''), 10) : 0;
    return { time, point, amount, raw: r.rowText };
  }).filter(r => !Number.isNaN(r.point) && r.amount > 0);

  console.log(`[UTILS] 銀行振込履歴取得: ${parsedBankRows.length}件`);
  return { bankRows: parsedBankRows, historyPage };
}

// ─── STEP15相当: ポイント差異チェック ─────────────────────────────
// 期待ポイントと実際のポイントを照合し、差異があればLINEに確認通知して
// 返信を待つ。実際の調整（adjustPoint呼び出し）は呼び出し側で行う
async function checkPointDiff(campaigns, bankRows, sendLine, waitForLineReply, DRY_RUN) {
  const totalAmount = bankRows.reduce((sum, r) => sum + r.amount, 0);
  const totalActual = bankRows.reduce((sum, r) => sum + r.point, 0);
  const totalExpected = bankRows.reduce((sum, r) => sum + Math.floor(r.amount / 10) + Math.floor(r.amount * 0.005), 0);
  const campaignBonus = calcExpectedPoints(totalAmount, campaigns).campaignBonus;
  const grandTotal = totalExpected + campaignBonus;
  const diff = totalActual - grandTotal;
  console.log(`[UTILS] 入金合計=${totalAmount}円 期待値合計=${grandTotal}pt（通常+サービス${totalExpected}+補助${campaignBonus}） 実際合計=${totalActual}pt 差異=${diff}`);

  if (diff === 0) {
    console.log('[UTILS] 一致 → 問題なし');
    return { totalAmount, totalActual, grandTotal, diff: 0, reply: null };
  }

  const diffLabel = diff < 0 ? '不足' : '過剰';
  const diffAbs = Math.abs(diff);

  await sendLine(
    `【ポイント確認】\n` +
    `入金合計：${totalAmount.toLocaleString('en-US')}円\n` +
    `期待ポイント合計：${grandTotal}pt\n` +
    `実際のポイント合計：${totalActual}pt\n` +
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

  return { totalAmount, totalActual, grandTotal, diff, reply };
}

module.exports = {
  openKyouseitaikai, adjustPoint, setPointLevel, getPointLevel, checkAndApplyDiscount,
  calcExpectedPoints, getTodayCampaignRows, getMailRows, getBankHistory, checkPointDiff,
};

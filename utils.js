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
  const markValue = sign === '+' ? '1' : '2';
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
 */
async function checkAndApplyDiscount(page, uid, campaigns, totalAmount, sendLine, waitForLineReply, DRY_RUN) {
  // 割引キャンペーンを取得
  const discountCampaigns = campaigns.filter(c => c.type === 'discount' && totalAmount >= c.amount);
  if (discountCampaigns.length === 0) return;

  const bestDiscount = Math.max(...discountCampaigns.map(c => c.discount));

  // 割引ptからポイントレベルのvalue値を決定
  const discountToLevel = {
    120: 10, 100: 11, 80: 22, 75: 12, 60: 24,
    50: 13, 40: 25, 30: 14, 25: 15, 20: 26, 10: 16, 1: 17
  };
  const targetLevel = discountToLevel[bestDiscount];
  if (!targetLevel) return;

  // 会員詳細ページを開いて現在のレベルを確認
  const kyouseiPage = await openKyouseitaikai(page, uid);
  const currentLevel = await getPointLevel(kyouseiPage);

  if (currentLevel === targetLevel) {
    console.log(`[DISCOUNT] uid=${uid}: 既に正しい割引レベル(${targetLevel})が適用済み`);
    await kyouseiPage.close();
    return;
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
  }

  await kyouseiPage.close();
}

module.exports = { openKyouseitaikai, adjustPoint, setPointLevel, getPointLevel, checkAndApplyDiscount };

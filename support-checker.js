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
const {
  openKyouseitaikai, adjustPoint, setPointLevel, getPointLevel, getCurrentPoint, getMemberBasicInfo, setLoveLevel,
  checkAndApplyDiscount,
  calcExpectedPoints, getMailRows, getBankHistory, checkPointDiff,
  runPaymentCommand,
} = require('./utils');
const { sendSlack, isSlackOnly } = require('./slack-notify');

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

// ─── 処理コマンド解析 ─────────────────────────────────────────────
// 「開始」「開始#補足」「手動対応」「スキップ」「〇pt追加」「〇pt減算」「レベル変更:〇」
// 「メール確認」「決済確認」「絆変更:{キャラID}:{value}」「{uid} {金額}円 入金」
// および上記の組み合わせ（例:「メール確認 決済確認 開始」）に対応する。
// 各コマンドは末尾に来る組み合わせもあるためincludesで判定する。
// ポイント操作は「ポイント」の接頭辞を省略でき、追加/減算のどちらも指定できる
// （point: { amount, sign } / signは追加なら '+'、減算なら '-'）
function parseCommand(reply) {
  const text = reply || '';
  // 補足（開始#〜）は末尾まで自由入力のため、補足内の文言を他コマンドと
  // 誤認しないよう、コマンド判定は補足を除いた部分に対して行う
  const body = text.replace(/開始#[\s\S]+/, '開始');
  return {
    point:      (m => (m ? { amount: m[1], sign: m[2] === '減算' ? '-' : '+' } : null))(body.match(/(?:ポイント)?(\d+)pt(追加|減算)/)),
    level:      body.match(/レベル変更:(\d+)/)?.[1] ?? null,
    start:      body.includes('開始'),
    supplement: text.match(/開始#([\s\S]+)/)?.[1]?.trim() || null,
    manual:     body.includes('手動対応'),
    payment:    (m => (m ? { uid: m[1], amount: parseInt(m[2].replace(/,/g, ''), 10) } : null))(body.match(/(\d+)\s+([\d,]+)円\s*入金/)),
    mail:       body.includes('メール確認'),
    bank:       body.includes('決済確認'),
    skip:       body.includes('スキップ'),
    love:       (m => (m ? { charaId: m[1], value: m[2] } : null))(body.match(/絆変更:(\d+):(\d+)/)),
  };
}

// 「手動対応」コマンド用の通知（返答生成は行わず、担当者へ対応を依頼する）
async function notifyManual(userName, uid) {
  await sendLine(`【手動対応】${userName}（uid:${uid || '不明'}）の対応をお願いします`);
}

// 決済履歴を取得できなかった場合（0件・遷移失敗いずれも）の通知文
const NO_BANK_HISTORY_MSG = '【決済履歴】当日の決済履歴はありません';

// 会員情報（ポイント・決済履歴・キャンペーン）の取得対象とする問い合わせの判定
// ポイント関連でない問い合わせでは取得せず、そのままコマンド待ちへ進む
const MEMBER_INFO_KEYWORDS = ['ポイント', 'pt', 'PT', '購入', '決済', '入金', 'キャンペーン', '割引'];

function needsMemberInfo(inquiryText) {
  if (!inquiryText) return false;
  return MEMBER_INFO_KEYWORDS.some(k => inquiryText.includes(k));
}

// ─── 会員基本情報（常時取得）─────────────────────────────────────────
// 問い合わせ受信時に常にkyouseitaikaiページから会員の基本情報を取得し、
// 通知用の行配列（【会員情報】ブロック）を返す。最終購入時間が本日日付と
// 一致する場合のみ getBankHistory() で当日の購入金額合計も取得する。
// 取得できない項目があっても例外は投げず、参照のみでポイントは変更しない。
function isLastPurchaseToday(lastPurchase) {
  if (!lastPurchase) return false;
  const m = String(lastPurchase).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return false;
  const [jy, jmo, jd] = new Date()
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
    .split('-').map(n => parseInt(n, 10));
  return parseInt(m[1], 10) === jy && parseInt(m[2], 10) === jmo && parseInt(m[3], 10) === jd;
}

async function collectMemberBasicInfo(page, uid) {
  const lines = ['【会員情報】'];
  if (!uid) {
    lines.push('会員IDが取得できず、会員情報を取得できませんでした');
    return lines;
  }

  let kyouseiPage = null;
  let historyPage = null;
  try {
    kyouseiPage = await openKyouseitaikai(page, uid);
    if (!kyouseiPage.url().includes('mg_kyoseitaikai')) {
      console.log(`[BASIC-INFO] uid=${uid}: 会員詳細ページへ遷移できず（URL=${kyouseiPage.url()}）`);
      lines.push('会員詳細ページを開けず、会員情報を取得できませんでした');
      return lines;
    }

    const info = await getMemberBasicInfo(kyouseiPage);
    lines.push(`ニックネーム：${info.nickname || '不明'}`);
    lines.push(`所持ポイント：${info.currentPoint ? `${info.currentPoint}pt` : '不明'}`);
    lines.push(`会員レベル：${info.memberLevel || '不明'}`);
    lines.push(`ポイントレベル：${info.pointLevel || '不明'}`);
    lines.push(`プロフィール2：${info.profile2 || '不明'}`);
    lines.push(`メモ：${info.memo || '（なし）'}`);

    // 最終購入時間が本日日付と一致する場合のみ当日購入金額合計を取得する
    if (isLastPurchaseToday(info.lastPurchase)) {
      // 既に会員詳細ページ（kyouseitaikai）を開いている状態のため、
      // getBankHistory()にskipBack:trueを渡してwindow.history.back()を行わせない。
      // （back()すると別ページに戻ってしまい「ポイント増減履歴」クリックが
      //   タイムアウトすることがあるため）
      // 念のため同URLを開き直し、会員詳細ページを確実にロードした状態にしてから
      // 履歴取得へ進む。
      await kyouseiPage.goto(kyouseiPage.url());
      await kyouseiPage.waitForLoadState('networkidle');

      const { paymentRows, historyPage: hp } = await getBankHistory(page, kyouseiPage, { skipBack: true });
      historyPage = hp;
      const todayAmount = paymentRows.reduce((sum, r) => sum + r.amount, 0);
      console.log(`[BASIC-INFO] uid=${uid}: 当日購入 ${paymentRows.length}件 合計${todayAmount}円`);
      lines.push(`当日購入金額：${todayAmount.toLocaleString('en-US')}円`);
    } else {
      console.log(`[BASIC-INFO] uid=${uid}: 最終購入時間=${info.lastPurchase || '（なし）'} は本日ではない → 当日購入金額の取得をスキップ`);
    }
  } catch (e) {
    console.log(`[BASIC-INFO] uid=${uid}: 会員基本情報の取得に失敗: ${e.message}`);
    lines.push('会員基本情報の取得に失敗しました');
  } finally {
    if (historyPage && historyPage !== kyouseiPage) await historyPage.close().catch(() => {});
    if (kyouseiPage) await kyouseiPage.close().catch(() => {});
  }
  return lines;
}

// ─── ポイント照合（ポイント・レベル・当日購入履歴）を取得する ─────────────
// 問い合わせ内容と併せてLINEへ通知するための情報をまとめて取得し、
// 通知用の行配列を返す。取得できない項目があっても例外は投げず、
// 取得できた範囲を返す（参照のみでポイントは変更しない）
async function collectMemberInfo(page, uid) {
  const lines = ['【ポイント照合】'];
  if (!uid) {
    lines.push('会員IDが取得できず、会員情報を取得できませんでした');
    return lines;
  }

  let kyouseiPage = null;
  let historyPage = null;
  try {
    kyouseiPage = await openKyouseitaikai(page, uid);
    if (!kyouseiPage.url().includes('mg_kyoseitaikai')) {
      console.log(`[MEMBER-INFO] uid=${uid}: 会員詳細ページへ遷移できず（URL=${kyouseiPage.url()}）`);
      lines.push('会員詳細ページを開けず、会員情報を取得できませんでした');
      return lines;
    }

    // 1. 現在のポイント数・ポイントレベル
    const point = await getCurrentPoint(kyouseiPage);
    const level = await kyouseiPage.evaluate(() => {
      const lvSelect = document.querySelector('select[name="update[lv]"]');
      return lvSelect ? lvSelect.selectedIndex : null;
    });
    const hasPoint = point !== null && !Number.isNaN(point);
    lines.push(`現在のポイント数：${hasPoint ? `${point}pt` : '不明'}`);
    lines.push(`ポイントレベル：${level === null ? '不明' : level}`);

    // 2. 当日配信メールからキャンペーン情報を取得（失敗時は補助0として続行）
    const campaigns = [];
    let mailCampaigns = []; // メール本文で検出した week/campaign 等（mail-campaign-info.json照合用）
    try {
      const mailRows = await getMailRows(kyouseiPage, SUPPORT_CHECK_TEST_MODE);
      for (const row of mailRows) {
        campaigns.push(...await parseCampaignWithClaude(row.bodyHtml));
      }
      mailCampaigns = mailRows.map(r => r.campaign).filter(Boolean);
      console.log(`[MEMBER-INFO] uid=${uid}: 当日配信メール${mailRows.length}件 キャンペーン${campaigns.length}件 検出コメント${mailCampaigns.length}件`);
    } catch (e) {
      console.log(`[MEMBER-INFO] uid=${uid}: キャンペーン情報の取得に失敗: ${e.message}`);
    }

    // 3. 当日購入履歴（getMailRows()でmg_mail_edit.phpへ遷移済みのため
    //    getBankHistory()内のwindow.history.back()で会員詳細へ戻れる）
    const { paymentRows, historyPage: hp } = await getBankHistory(page, kyouseiPage);
    historyPage = hp;
    console.log(`[MEMBER-INFO] uid=${uid}: 当日購入履歴 ${paymentRows.length}件`);
    if (paymentRows.length === 0) {
      lines.push('当日購入履歴：無');
      return lines;
    }

    // 4. 想定ポイントと実際の付与ポイントを照合（checkPointDiff と同じ計算）
    const totalAmount = paymentRows.reduce((sum, r) => sum + r.amount, 0);
    const normalPt = paymentRows.reduce((sum, r) => sum + Math.floor(r.amount / 10), 0);
    const servicePt = paymentRows.reduce(
      (sum, r) => sum + (r.isBankTransfer ? Math.floor(r.amount * 0.005) : 0), 0);
    const campaignBonus = calcExpectedPoints(totalAmount, campaigns, mailCampaigns).campaignBonus;
    const expectedPt = normalPt + servicePt + campaignBonus;
    const actualPt = paymentRows.reduce((sum, r) => sum + r.point, 0);

    lines.push('当日購入履歴：有');
    lines.push(`当日購入総額：${totalAmount.toLocaleString('en-US')}円`);
    // 決済前ポイント = 現在のポイント - 当日追加された実際のポイント合計
    if (hasPoint) lines.push(`決済前ポイント：${point - actualPt}pt`);
    lines.push(`想定追加ポイント：${expectedPt}pt（通常${normalPt}+サービス${servicePt}+補助${campaignBonus}）`);
    lines.push(`実際の追加ポイント：${actualPt}pt`);
    lines.push(`差異：${actualPt - expectedPt}pt`);
  } catch (e) {
    console.log(`[MEMBER-INFO] uid=${uid}: 会員情報の取得に失敗: ${e.message}`);
    lines.push('会員情報の取得に失敗しました');
  } finally {
    if (historyPage && historyPage !== kyouseiPage) await historyPage.close().catch(() => {});
    if (kyouseiPage) await kyouseiPage.close().catch(() => {});
  }
  return lines;
}

// 処理コマンド待ちでLINEに表示するコマンド一覧
// startLabel: 「開始」の説明（ポイント関連の問い合わせか否かで文言が異なる）
function commandHelpLines(startLabel) {
  return [
    `「開始」：${startLabel}`,
    '「開始#補足」：補足を踏まえて実行',
    '「手動対応」：手動対応を通知して次のユーザーへ',
    '「スキップ」：通知なしで次のユーザーへ',
    '「{数値}pt追加」「{数値}pt減算」：ポイント増減のみ',
    '「レベル変更:{数値}」：レベル変更のみ',
    '「メール確認」：当日配信メールを通知',
    '「決済確認」：当日決済履歴を通知',
    '「絆変更:{キャラID}:{value}」：絆レベル変更のみ',
    '「{uid} {金額}円 入金」：手動で入金処理を実行',
    '（例）「メール確認 決済確認 開始」',
  ];
}

// ─── 1コマンド分の照会・更新系処理をまとめて実行する ─────────────────
// 「開始」「手動対応」「スキップ」以外のコマンド（メール確認/決済確認/絆変更/
// ポイント追加/レベル変更）を処理する
async function runSubCommands(page, uid, cmd) {
  if (cmd.mail) await notifyTodayMails(page, uid);
  if (cmd.bank) await notifyBankHistory(page, uid);
  if (cmd.love) await applyLoveLevel(page, uid, cmd.love.charaId, cmd.love.value);
  // 「{uid} {金額}円 入金」手動入金処理（コマンド内のuidを使用する）
  if (cmd.payment) await runPaymentCommand(cmd.payment.uid, cmd.payment.amount, sendLine, DRY_RUN);

  if ((cmd.point || cmd.level) && !uid) {
    console.log('[WARN] uid未取得のためポイント/レベル操作をスキップ');
    await sendLine('【エラー】会員IDが取得できず、ポイント/レベル操作を実行できませんでした');
    return;
  }

  if (cmd.point) {
    const { amount, sign } = cmd.point;
    const label = sign === '-' ? '減算' : '追加';
    if (DRY_RUN) {
      console.log(`[DRY RUN] uid=${uid}: ポイント${label}(${amount}pt)をスキップ`);
      await sendLine(`【DRY RUN】${amount}ptの${label}をスキップしました`);
    } else {
      try {
        const ptPage = await openKyouseitaikai(page, uid);
        await adjustPoint(ptPage, amount, sign);
        await ptPage.close().catch(() => {});
        await sendLine(`【完了】${amount}ptを${label}しました`);
      } catch (e) {
        console.log(`[POINT] uid=${uid}: ポイント${label}に失敗: ${e.message}`);
        await sendLine(`【エラー】ポイント${label}に失敗しました: ${e.message}`);
      }
    }
  }

  if (cmd.level) {
    const level = cmd.level;
    if (DRY_RUN) {
      console.log(`[DRY RUN] uid=${uid}: レベル変更(${level})をスキップ`);
      await sendLine(`【DRY RUN】レベル${level}への変更をスキップしました`);
    } else {
      try {
        const lvPage = await openKyouseitaikai(page, uid);
        await setPointLevel(lvPage, level);
        await lvPage.close().catch(() => {});
        await sendLine(`【完了】レベルを${level}に変更しました`);
      } catch (e) {
        console.log(`[LEVEL] uid=${uid}: レベル変更に失敗: ${e.message}`);
        await sendLine(`【エラー】レベル変更に失敗しました: ${e.message}`);
      }
    }
  }
}

// ─── 処理コマンド待ちループ ───────────────────────────────────────
// 問い合わせ内容を表示してコマンドを待ち、照会コマンド（メール確認/決済確認）
// を受けた場合は結果を通知したうえで再度コマンド待ちに戻る。
// 戻り値: 解析済みコマンド（タイムアウト・停止要求時は null）
async function waitForCommand(page, candidate, headerLines, startLabel) {
  const helpLines = commandHelpLines(startLabel);
  let firstPrompt = true;

  while (true) {
    await sendLine(firstPrompt
      ? [...headerLines, '', '処理コマンドを入力してください：', ...helpLines].join('\n')
      : [
          '【コマンド待ち】',
          `ユーザー：${candidate.userName}`,
          '続けて処理コマンドを入力してください：',
          ...helpLines,
        ].join('\n'));
    firstPrompt = false;

    let reply;
    try {
      reply = await waitForLineReply();
    } catch (e) {
      console.log(`[TIMEOUT] ${candidate.userName}: 処理コマンド待ち タイムアウト → スキップ`);
      return null;
    }
    console.log(`[LINE] 処理コマンド返信: ${reply}`);

    const parsed = parseCommand(reply);

    // 照会・更新系コマンド（メール確認/決済確認/絆変更/ポイント/レベル）を実行
    await runSubCommands(page, candidate.uid, parsed);

    // 照会・入金コマンドが含まれ、かつ「開始」「手動対応」「スキップ」の指示が
    // なければ、結果を確認したうえで次のコマンドを入力できるようコマンド待ちに戻る
    if ((parsed.mail || parsed.bank || parsed.payment) && !parsed.start && !parsed.manual && !parsed.skip) {
      console.log(`[CMD] ${candidate.userName}: 照会/入金コマンドのみ → 再度コマンド待ちへ`);
      continue;
    }

    return { ...parsed, reply };
  }
}

// ─── 「絆変更:{キャラID}:{value}」コマンド ─────────────────────────
// 指定キャラIDの絆レベルを確認なしで即時変更する
async function applyLoveLevel(page, uid, charaId, value) {
  if (!uid) {
    await sendLine('【エラー】会員IDが取得できず、絆レベル変更を実行できませんでした');
    return;
  }
  if (DRY_RUN) {
    console.log(`[LOVE] uid=${uid}: 絆レベル変更(cid=${charaId} value=${value})をスキップ`);
    await sendLine(`【DRY RUN】キャラ${charaId}の絆レベル変更（value=${value}）をスキップしました`);
    return;
  }
  try {
    await setLoveLevel(page, uid, charaId, value);
    await sendLine(`【完了】uid=${uid} キャラ${charaId}の絆レベルをvalue=${value}に変更しました`);
  } catch (e) {
    console.log(`[LOVE] uid=${uid}: 絆レベル変更に失敗: ${e.message}`);
    await sendLine(`【エラー】絆レベル変更に失敗しました: ${e.message}`);
  }
}

// ─── 「メール確認」コマンド ───────────────────────────────────────
// 会員詳細ページからgetMailRows()で当日配信メールを取得し、一覧をLINEへ通知する
async function notifyTodayMails(page, uid) {
  if (!uid) {
    await sendLine('【エラー】会員IDが取得できず、メール確認を実行できませんでした');
    return;
  }
  let kyouseiPage = null;
  try {
    kyouseiPage = await openKyouseitaikai(page, uid);
    const mailRows = await getMailRows(kyouseiPage, SUPPORT_CHECK_TEST_MODE);
    console.log(`[MAIL-CHECK] uid=${uid}: 当日配信メール ${mailRows.length}件`);
    if (mailRows.length === 0) {
      await sendLine('【当日配信メール】\n当日配信されたお知らせメールはありませんでした');
      return;
    }
    await sendLine([
      '【当日配信メール】',
      ...mailRows.map((row, i) => `メール${i + 1}: ${row.title || '（タイトルなし）'}`),
    ].join('\n'));
  } catch (e) {
    console.log(`[MAIL-CHECK] uid=${uid}: メール確認に失敗: ${e.message}`);
    await sendLine(`【エラー】メール確認に失敗しました: ${e.message}`);
  } finally {
    if (kyouseiPage) await kyouseiPage.close().catch(() => {});
  }
}

// ─── 「決済確認」コマンド ───────────────────────────────────────
// 会員詳細ページからgetBankHistory()で当日の決済履歴を取得し、LINEへ通知する
// （参照のみでポイントは変更しないためDRY_RUN時も実行する）
async function notifyBankHistory(page, uid) {
  if (!uid) {
    await sendLine('【エラー】会員IDが取得できず、決済確認を実行できませんでした');
    return;
  }
  let kyouseiPage = null;
  let historyPage = null;
  try {
    kyouseiPage = await openKyouseitaikai(page, uid);
    // about:blank等で会員詳細ページを開けなかった場合はエラーにせず
    // 「履歴なし」として扱い、コマンド待ちに戻す
    if (!kyouseiPage.url().includes('mg_kyoseitaikai')) {
      console.log(`[BANK-CHECK] uid=${uid}: 会員詳細ページへ遷移できず（URL=${kyouseiPage.url()}）`);
      await sendLine(NO_BANK_HISTORY_MSG);
      return;
    }

    // getBankHistory()は「お知らせメール一覧から会員詳細へ戻る」前提で
    // window.history.back()を実行するため、単独実行時に戻り先が無くならないよう
    // 同じURLをもう一度開いて履歴を1つ積んでおく
    await kyouseiPage.goto(kyouseiPage.url());
    await kyouseiPage.waitForLoadState('networkidle');

    const { paymentRows, historyPage: hp } = await getBankHistory(page, kyouseiPage);
    historyPage = hp;
    console.log(`[BANK-CHECK] uid=${uid}: 当日決済履歴 ${paymentRows.length}件`);
    if (paymentRows.length === 0) {
      await sendLine(NO_BANK_HISTORY_MSG);
      return;
    }
    const total = paymentRows.reduce((sum, r) => sum + r.amount, 0);
    await sendLine([
      '【当日決済履歴】',
      ...paymentRows.map(r => `${r.time} | ${r.amount.toLocaleString('en-US')}円 | ${r.point}pt`),
      `合計：${total.toLocaleString('en-US')}円`,
    ].join('\n'));
  } catch (e) {
    // ページ遷移・要素待ちの失敗（about:blankのままback()した場合等）も
    // エラー通知にせず「履歴なし」として扱う
    console.log(`[BANK-CHECK] uid=${uid}: 決済履歴を取得できませんでした: ${e.message}`);
    await sendLine(NO_BANK_HISTORY_MSG);
  } finally {
    if (historyPage && historyPage !== kyouseiPage) await historyPage.close().catch(() => {});
    if (kyouseiPage) await kyouseiPage.close().catch(() => {});
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

  await page.fill('[name="id"]',    process.env.CHECK_LOGIN_ID);
  await page.fill('[name="pass"]',  process.env.CHECK_LOGIN_PASS);
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

      // formのaction属性からk_idとu_idを抽出する（reply-checker.jsのgetTargetUsersと同じ方法）
      const form = row.querySelector('form[action*="k_id="]');
      const action = form ? (form.getAttribute('action') || '') : '';
      const km = action.match(/k_id=(\d+)&(?:amp;)?u_id=(\d+)/);

      results.push({
        userName,
        stringID: m[1],
        kid: km ? km[1] : '',
        uid: km ? km[2] : '',
      });
    }
    return results;
  });

  console.log(`[SUPPORT] #ffffe0 候補: ${candidates.length}件`);
  return candidates;
}



async function countSupportTargets() {
  console.log('[SUPPORT-COUNT] 件数確認開始');

  const { chromium } = require('playwright');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox']
  });

  const context = await browser.newContext({
    httpCredentials: {
      username: process.env.BASIC_AUTH_ID,
      password: process.env.BASIC_AUTH_PASS,
    },
  });

  try {
    const page = await context.newPage();

    await login(page);
    await openSupportPage(page);

    const candidates = await getFfffe0Candidates(page);
    const count = candidates.length;

    console.log(`[SUPPORT-COUNT] 対象件数=${count}`);

    return count;

  } catch (err) {
    console.error(
      '[SUPPORT-COUNT] 件数取得エラー:',
      err.message
    );

    return null;

  } finally {
    await browser.close().catch(() => {});
  }
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




async function countSupportTargets() {
  console.log('=== support-checker 件数確認開始 ===');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox']
  });

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

    const candidates =
      await getFfffe0Candidates(supportPage);

    const count = candidates.length;

    console.log(
      `[SUPPORT-COUNT] サポート対象：${count}件`
    );

    return count;

  } catch (err) {
    console.error(
      '[SUPPORT-COUNT] 件数取得エラー:',
      err.message
    );

    return null;

  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── 最新ユーザーメッセージの受信日時を取得 ─────────────────────────
// 画面は「最新が上・下ほど古い」構成。鑑定士側の送信履歴は背景色 #90EE90(緑)で
// 表示され、その緑ブロックより上が最新のユーザーメッセージ群になる。
// 取得対象は「鑑定士側の送信履歴の一つ上にあるユーザーメッセージの受信日時」
// = 最初(最新)の緑ブロックの直前にある日時td（<td>07月26日 10時00分</td> 形式）。
async function getLatestUserDatetime(page) {
  const mainFrame = page.frame({ name: 'ope_main' });
  if (!mainFrame) return '';
  try {
    return await mainFrame.evaluate(() => {
      const DATE_RE = /(\d{1,2}月\d{1,2}日\s*\d{1,2}時\d{1,2}分)/;
      // 日時のみのtd（本文中に日付が混ざったtdを誤検知しないよう厳密一致）
      const DATE_ONLY_RE = /^\s*\d{1,2}月\d{1,2}日\s*\d{1,2}時\d{1,2}分\s*$/;
      const norm = el => (el.getAttribute('style') || '').replace(/\s/g, '').toLowerCase();

      // 鑑定士側(緑背景 #90EE90)の最初(=最新)のブロックを特定
      const green = Array.from(document.querySelectorAll('*')).find(el => {
        const s = norm(el);
        return s.includes('90ee90') || s.includes('144,238,144');
      }) || null;

      const dateTds = Array.from(document.querySelectorAll('td'))
        .filter(td => DATE_ONLY_RE.test(td.textContent || ''));

      let target = null;
      if (green) {
        // 緑ブロックより前(=上=新しい側)の日時tdのうち、緑に最も近い(=一つ上)もの。
        // 緑ブロック内に含まれる鑑定士自身の日時はPRECEDINGにならないため自動的に除外される。
        const before = dateTds.filter(
          td => green.compareDocumentPosition(td) & Node.DOCUMENT_POSITION_PRECEDING
        );
        target = before.length ? before[before.length - 1] : null;
      }
      // フォールバック: 緑が無い/緑より上に日時が無い場合は先頭(最新)の日時td
      if (!target) target = dateTds[0] || null;
      if (!target) return '';

      const m = (target.textContent || '').match(DATE_RE);
      return m ? m[1].replace(/\s+/g, ' ').trim() : '';
    });
  } catch (e) {
    console.error('[ERROR] getLatestUserDatetime:', e.message);
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
async function matchTemplate(inquiryText, charaId = null) {
  const templates = JSON.parse(fs.readFileSync(CONTACT_TEMPLATES_PATH, 'utf8')).templates;

  // charaId制約チェック: テンプレートにcharaIdがある場合は対象キャラIDと一致必須
  const charaOk = (t) => !t.charaId || String(t.charaId) === String(charaId);

  // 1. キーワードベース判定（keywordMatchを明示的に持つテンプレートのみ対象）
  //    keywordMatch="any": いずれか1つでも含まれれば一致 / それ以外: 全て含む場合に一致
  for (const t of templates) {
    if (!t.keywordMatch || !Array.isArray(t.keywords) || t.keywords.length === 0) continue;
    if (!charaOk(t)) continue;
    // excludeExactの文字列と完全一致する場合はマッチさせない
    // （申請キーワードそのものの送信はテンプレ返答の対象外）
    if (Array.isArray(t.excludeExact) && t.excludeExact.includes(inquiryText.trim())) {
      console.log(`[TEMPLATE] ${t.id}: excludeExact完全一致のため除外 ("${inquiryText.trim()}")`);
      continue;
    }
    const matched = t.keywordMatch === 'any'
      ? t.keywords.some(k => inquiryText.includes(k))
      : t.keywords.every(k => inquiryText.includes(k));
    if (matched) {
      console.log(`[TEMPLATE] キーワード一致: ${t.id} (keywordMatch=${t.keywordMatch}, charaId=${t.charaId ?? 'なし'})`);
      return t.id;
    }
  }

  // 2. Claude APIによる分類（従来ロジック）
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 100,
    system: 'テンプレートIDのみをJSON形式で返してください。',
    messages: [{
      role: 'user',
      content: `以下の問い合わせに最も近いテンプレートIDを返してください。
該当なしの場合はnullを返してください。

テンプレートID一覧：
withdraw: 退会したい・退会申請
mail_open: メールが開けない・メールが見れない・メールボックスが開かない
no_reply: 先生から返事が来ない・返信がない・連絡がない
unclear: 問い合わせ内容が意味不明・何を聞いているかわからない
message_to_teacher: 先生への伝言・先生に伝えてほしい
login: ログインできない・サイトに入れない
point_purchase: ポイントの買い方・購入方法・決済方法を知りたい
free_period: 無料期間はいつまでか・無料はどのくらいか
discount_ticket: 割引チケット・ガチャチケット・クーポンの使い方

ポイントの残高・計算・反映などに関する問い合わせはnullを返してください。
購入方法を聞いている場合のみpoint_purchaseを選択してください。

問い合わせ内容：${inquiryText}

{"templateId": "ID"} の形式で返してください。`,
    }],
  });

  const text = (response.content.find(b => b.type === 'text')?.text ?? '').trim();
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  const id = parsed.templateId || null;
  if (!id) return null;
  // Claudeが返したテンプレートにcharaId制約がある場合は一致時のみ採用
  const picked = templates.find(t => t.id === id);
  if (picked && !charaOk(picked)) {
    console.log(`[TEMPLATE] ${id} はcharaId=${picked.charaId}専用のため対象外（現在=${charaId}）`);
    return null;
  }
  return id;
}

// ─── テンプレート該当なし時、Claude APIで返答文を自動生成する ──────────
// （contact-checker.js の generateReplyWithClaude と同じロジック）
// 生成失敗時はnullを返し、呼び出し側は既存の手動対応フローへ進む
async function generateReplyWithClaude(inquiryText, supplement = null) {
  let userPrompt = `以下のユーザーからの問い合わせに対して返答文を生成してください。\n問い合わせ内容：${inquiryText}`;
  if (supplement) {
    userPrompt += `\n\nオペレーターからの補足指示：${supplement}\nこの補足も踏まえて返答文を生成してください。`;
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    system: 'あなたはRUNEというサービスのサポートセンタースタッフです。\n' +
      '以下のルールに従って返答文を生成してください。\n\n' +
      '・問い合わせは全て会員IDに紐づいています\n' +
      '・アカウント情報・ポイント数・注文番号・キャンペーン名などは\n' +
      '  こちら側で確認済みの前提で対応してください\n' +
      '・ユーザーに追加情報を聞き返すことは絶対にしないでください\n' +
      '・対応済みの内容がある場合はその内容を踏まえた返答をしてください\n' +
      '・丁寧な敬語で簡潔に返答してください\n' +
      '・「会員様」という表記は使わず「お客様」に統一してください\n' +
      '・対応内容の説明は簡潔にしてください\n' +
      '  例：「〇ptを追加いたしました」「割引率を〇ptへ修正いたしました」程度で十分です\n' +
      '  レベル番号・割引前後の詳細な数値・変更理由の説明は入れないでください\n' +
      '  細かい説明はユーザーを混乱させる可能性があるため避けてください\n' +
      '・最後にRUNEインフォメーションという署名を入れてください',
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = (response.content.find(b => b.type === 'text')?.text ?? '').trim();
  return text || null;
}

// テンプレート自動返答の送信処理（reply-checker.js の sendReplyText と同じ
// ロジック: ope_mainフレーム内の textarea#mess_body に入力して #chara_mail_send をクリック）
async function sendSupportReplyText(page, userName, textToSend) {
  console.log(`[SEND-TEXT] 送信内容: "${textToSend.slice(0, 80)}..."`);
  if (DRY_RUN) {
    console.log(`[DRY RUN] 送信をスキップ: ${userName}`);
    await sendLine(`【DRY RUN】${userName}への自動返答送信をスキップしました`);
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
  console.log(`[SEND] ${userName} 自動返答送信完了`);
  await sendLine(`【送信完了】${userName}へ自動返答を送信しました`);
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

// getTodayCampaignRows は utils.js に移動（重複ロジックのため）

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

// calcExpectedPoints は utils.js に移動（重複ロジックのため）

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
        console.log(`[STEP3] ${candidate.userName}: ポイント関連の問い合わせではない → 処理コマンドを待つ`);

        // ─── 問い合わせ内容を表示し、処理コマンドを待つ ─────────────
        // 照会コマンド（メール確認/決済確認）実行後はコマンド待ちに戻る
        const latestDatetime = await getLatestUserDatetime(page);
        // 会員基本情報（【会員情報】）は常時取得する。
        // ポイント関連の問い合わせのみポイント照合（【ポイント照合】）も取得する。
        const basicInfoLines = await collectMemberBasicInfo(page, candidate.uid);
        let memberInfoLines = [];
        if (needsMemberInfo(latestMessage)) {
          memberInfoLines = await collectMemberInfo(page, candidate.uid);
        } else {
          console.log(`[MEMBER-INFO] ${candidate.userName}: ポイント関連キーワードなし → ポイント照合の取得をスキップ`);
        }
        const cmd = await waitForCommand(page, candidate, [
          '【問い合わせ受信】',
          `会員ID：${candidate.uid}`,
          `ユーザー：${candidate.userName}`,
          `受信日時：${latestDatetime || '（不明）'}`,
          '---',
          latestMessage,
          '---',
          ...basicInfoLines,
          ...(memberInfoLines.length > 0 ? ['', ...memberInfoLines] : []),
        ], '返答生成へ');
        if (!cmd) continue;

        const { start: startMatch, supplement, manual: manualMatch } = cmd;
        const cmdReply = cmd.reply;

        // 3. 「手動対応」：LINEへ手動対応を通知して次のユーザーへ
        if (manualMatch) {
          console.log(`[MANUAL] ${candidate.userName}: 手動対応コマンド → 通知して次のユーザーへ`);
          await notifyManual(candidate.userName, candidate.uid);
          continue;
        }

        // 4. 「開始」がなければ（スキップ・ポイント/レベル操作のみ含む）通知なしで次のユーザーへ
        if (!startMatch) {
          console.log(`[SKIP] ${candidate.userName}: 開始コマンドなし（reply="${cmdReply}"）→ 次のユーザーへ`);
          continue;
        }

        // ─── 返答生成（テンプレート判定 → AI生成、supplementはAI生成に反映） ──
        let templateId = null;
        try {
          templateId = await matchTemplate(latestMessage, candidate.kid);
        } catch (e) {
          console.log(`[TEMPLATE] ${candidate.userName}: テンプレート判定に失敗: ${e.message}`);
        }
        console.log(`[TEMPLATE] ${candidate.userName}: templateId=${templateId}`);

        if (templateId) {
          const templates = JSON.parse(fs.readFileSync(CONTACT_TEMPLATES_PATH, 'utf8')).templates;
          const template = templates.find(t => t.id === templateId);
          if (!template) {
            console.log(`[TEMPLATE] ${candidate.userName}: templateId="${templateId}" に一致するテンプレートが見つかりません`);
          } else {
            await sendLine([
              '【自動返答候補】',
              `ユーザー：${candidate.userName}`,
              `テンプレート：${template.id}`,
              '---',
              template.response,
              '---',
              '「送信」：そのまま送信',
              '「手動対応」：手動対応を通知して次のユーザーへ',
              '「スキップ」：通知なしで次のユーザーへ',
            ].join('\n'));

            let autoReply = null;
            try {
              autoReply = await waitForLineReply();
            } catch (e) {
              console.log(`[TIMEOUT] ${candidate.userName}: 自動返答確認 5分タイムアウト → 手動対応へ`);
            }
            console.log(`[LINE] 自動返答確認返信: ${autoReply}`);

            // 未返信（タイムアウト）も手動対応として通知する
            if (autoReply === '送信') {
              await sendSupportReplyText(page, candidate.userName, template.response);
            } else if (!autoReply || autoReply.includes('手動対応')) {
              console.log(`[MANUAL] ${candidate.userName}: 自動返答を送信せず手動対応`);
              await notifyManual(candidate.userName, candidate.uid);
            } else {
              console.log(`[TEMPLATE] ${candidate.userName}: 自動返答をスキップ（通知なし）`);
            }
          }
        }

        if (!templateId) {
          let aiReplyText = null;
          try {
            aiReplyText = await generateReplyWithClaude(latestMessage, supplement);
          } catch (e) {
            console.log(`[AI-REPLY] ${candidate.userName}: 返答文生成に失敗: ${e.message}`);
          }

          if (aiReplyText) {
            await sendLine([
              '【AI生成返答】',
              `ユーザー：${candidate.userName}`,
              '---',
              aiReplyText,
              '---',
              '「送信」：そのまま送信',
              '「差し替え#文章」：内容を変更して送信',
              '「手動対応」：手動対応を通知して次のユーザーへ',
              '「スキップ」：通知なしで次のユーザーへ',
            ].join('\n'));

            let aiReply = null;
            try {
              aiReply = await waitForLineReply();
            } catch (e) {
              console.log(`[TIMEOUT] ${candidate.userName}: AI生成返答確認 5分タイムアウト → 手動対応へ`);
            }
            console.log(`[LINE] AI生成返答確認返信: ${aiReply}`);

            // 未返信（タイムアウト）も手動対応として通知する
            if (aiReply === '送信') {
              await sendSupportReplyText(page, candidate.userName, aiReplyText);
            } else if (aiReply && aiReply.startsWith('差し替え#')) {
              const replacedText = aiReply.replace(/^差し替え#/, '').trim();
              await sendSupportReplyText(page, candidate.userName, replacedText);
            } else if (!aiReply || aiReply.includes('手動対応')) {
              console.log(`[MANUAL] ${candidate.userName}: AI生成返答を送信せず手動対応`);
              await notifyManual(candidate.userName, candidate.uid);
            } else {
              console.log(`[AI-REPLY] ${candidate.userName}: AI生成返答をスキップ（通知なし）`);
            }
          }
        }

        console.log(`[STEP3] ${candidate.userName}: 返答生成フロー完了 → 次のユーザーへ`);
        continue;
      }

      console.log(`[STEP3] ${candidate.userName}: ポイント関連の問い合わせと判定`);

      // ─── 問い合わせ内容を表示し、処理コマンドを待つ ─────────────────
      // 照会コマンド（メール確認/決済確認）実行後はコマンド待ちに戻る
      const latestDatetime = await getLatestUserDatetime(page);
      // 会員基本情報（【会員情報】）は常時取得する。
      // ポイント関連の問い合わせのみポイント照合（【ポイント照合】）も取得する。
      const basicInfoLines = await collectMemberBasicInfo(page, candidate.uid);
      let memberInfoLines = [];
      if (needsMemberInfo(latestMessage)) {
        memberInfoLines = await collectMemberInfo(page, candidate.uid);
      } else {
        console.log(`[MEMBER-INFO] ${candidate.userName}: ポイント関連キーワードなし → ポイント照合の取得をスキップ`);
      }
      const cmd = await waitForCommand(page, candidate, [
        '【問い合わせ受信】',
        `会員ID：${candidate.uid}`,
        `ユーザー：${candidate.userName}`,
        `受信日時：${latestDatetime || '（不明）'}`,
        '---',
        latestMessage,
        '---',
        ...basicInfoLines,
        ...(memberInfoLines.length > 0 ? ['', ...memberInfoLines] : []),
      ], 'キャンペーン・ポイントチェックを実行');
      if (!cmd) continue;

      const { start: startMatch, supplement, manual: manualMatch } = cmd;
      const startReply = cmd.reply;

      // 3. 「手動対応」：LINEへ手動対応を通知して次の候補へ
      if (manualMatch) {
        console.log(`[MANUAL] ${candidate.userName}: 手動対応コマンド → 通知して次のユーザーへ`);
        await notifyManual(candidate.userName, candidate.uid);
        continue;
      }

      // 4. 「開始」がなければ（スキップ・ポイント/レベル操作のみ含む）通知なしで次の候補へ
      if (!startMatch) {
        console.log(`[SKIP] ${candidate.userName}: 開始コマンドなし（reply="${startReply}"）→ 次のユーザーへ`);
        continue;
      }
      // サポートの対象処理はキャンペーン・ポイント照合であり返答生成(Claude)を
      // 行わないため、補足(supplement)は記録のみ（プロンプトへの反映先がない）
      if (supplement) {
        console.log(`[SUPPORT] ${candidate.userName}: 補足="${supplement}"（対象処理では未使用・記録のみ）`);
      }

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

    console.log(SUPPORT_CHECK_TEST_MODE
      ? '[STEP5-6] 「お知らせメッセージ編集」→mg_mail_edit.phpから本日の配信メール一覧を取得（テストモード：時間制限なし）'
      : '[STEP5-6] 「お知らせメッセージ編集」→mg_mail_edit.phpから本日8時以降の配信メール一覧を取得');
    const mailRows = await getMailRows(mainFrame, SUPPORT_CHECK_TEST_MODE);
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
    // 割引率調整・ポイント差異調整で実在ユーザーの所持ポイント・レベルを
    // 変更するため、DRY_RUN=trueの間はSTEP10-17を一切実行しない
    if (DRY_RUN) {
      console.log('[DRY RUN] ポイント履歴確認・調整処理（STEP10-17）をスキップ');
    } else {
      const allCampaigns = mails.flatMap(m => m.campaigns);
      console.log('[DEBUG] allCampaigns:', JSON.stringify(allCampaigns));

      console.log('[STEP10-14] ブラウザバック→ポイント増減履歴から当日の増減履歴（決済/行動/手動）を取得');
      const { paymentRows, actionRows, manualRows, historyPage, couponLevel, prePayment } = await getBankHistory(page, mainFrame, { resolvePrePayment: true });
      console.log(`[STEP14] 抽出成功: 決済${paymentRows.length}件 / 行動履歴${actionRows.length}件 / 手動操作${manualRows.length}件`);

      console.log('[STEP15] ポイント計算と照合（決済前ポイント基準の「追加ポイント確認」）');
      const { totalAmount, diff, reply } = await checkPointDiff(allCampaigns, paymentRows, sendLine, waitForLineReply, DRY_RUN, couponLevel, actionRows, manualRows, prePayment);

      if (diff !== 0) {
        if (reply === '調整する' && !DRY_RUN) {
          console.log('[STEP17] 会員詳細ページに戻りポイントを調整');
          if (historyPage !== mainFrame) {
            await historyPage.close().catch(() => {});
          } else {
            await mainFrame.evaluate(() => window.history.back());
            await new Promise(r => setTimeout(r, 2000));
          }

          const sign = diff < 0 ? '+' : '-';
          const diffAbs = Math.abs(diff);
          console.log(`[STEP17] ${sign}${diffAbs}pt を調整`);
          const adjustPage = await openKyouseitaikai(page, target.uid);
          await adjustPoint(adjustPage, diffAbs, sign);
          await adjustPage.close();
          await sendLine(`【ポイント調整完了】${diffAbs}ptを${sign === '+' ? '追加' : '減算'}しました`);
        } else if (reply !== null) {
          console.log('[STEP16] スキップが選択されました');
        }
      }

      // ─── 割引率チェック・適用（utils.js） ──────────────────────
      if (target.uid) {
        try {
          await checkAndApplyDiscount(page, target.uid, allCampaigns, totalAmount, sendLine, waitForLineReply, DRY_RUN);
        } catch (e) {
          console.log(`[DISCOUNT] ${target.userName}: 割引率チェックに失敗: ${e.message}`);
        }
      } else {
        console.log(`[DISCOUNT] ${target.userName}: uidが取得できないため割引率チェックをスキップ`);
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

module.exports = {
  checkSupport,
  stopSupport,
  countSupportTargets
};
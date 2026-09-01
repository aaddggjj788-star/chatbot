'use strict';

/**
 * contact-checker.js
 * mg_contactMail.php の未処理コンタクトメール一覧を取得し、
 * LINEで返答内容を確認しながらPlaywrightで送信するスクリプト
 *
 * 配置場所: /root/rune-bot/contact-checker.js
 * 実行: node contact-checker.js  または  server.js から checkContacts() を呼ぶ
 *
 * 【処理フロー】
 *   STEP1: mg_contactMail.php を開く（メインページのリンクをクリック）
 *   STEP2: 「実行」ボタンをクリックして一覧を表示
 *   STEP3: background-color: #ffaaaa の行を未処理として取得
 *   STEP4: mg_contact_edit.php?uid={uid}（スレッド確認ページ）を新しい
 *          ページとして開き、background-color: #aaaaff のtrを全件取得して
 *          各tr内の textarea[name^="mess["] から問い合わせ内容を取得する。
 *          取得した内容と会員情報（ポイント数・レベル・当日購入履歴）を
 *          まず「【問い合わせ受信】」としてLINEに表示する
 *   STEP4.5: 問い合わせ内容にポイント関連キーワードが含まれる場合のみ、
 *          uidの本日配信メールからキャンペーンを解析し、
 *          1) 割引率調整（utils.jsのcheckAndApplyDiscount）
 *          2) ポイント差異調整（utils.jsのcheckPointDiff、差異があれば
 *             「調整する」で調整）の順で実行する
 *          （support-checker.jsのSTEP4-6・11-15相当）
 *   STEP4.6: 返答方法はコマンドで明示的に指定する（テンプレート自動照合は廃止）。
 *          「テンプレート{番号}」→ contact-templates.json の該当番号の
 *            テンプレートを使用（送信確認後に送信）
 *          「開始」→ STEP4.5で実施した割引率・ポイント調整の内容を
 *            プロンプトに含めた上でClaude APIで返答文を自動生成しLINEで確認。
 *            「送信」でそのまま送信、「差し替え#文章」で内容を変更して送信、
 *            それ以外は手動対応フローへ
 *          「開始#補足」→ 補足を踏まえてClaude APIで返答文を自動生成
 *   STEP5: LINEに問い合わせ内容を通知し、返答内容の入力を依頼
 *   STEP6: LINEからの返答を受け取る（5分タイムアウト、「スキップ」で次へ）
 *   STEP7: テンプレートに差し込んだ送信内容をLINEで確認
 *   STEP8: 「送信」の場合、STEP4で開いたthreadPageのフォーム
 *          （textarea#messTempBody）に入力して送信
 *          ※件名は本文の1行目が自動的に使われるため入力しない
 *
 * 【LINE返信待ちの仕組み】
 *   reply-checker.js と同じ /tmp/rune-reply-state.json を共有し、
 *   server.js の LINE webhook からの返信をポーリングで検知する（タイムアウト5分）
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk').default;
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const {
  openKyouseitaikai, adjustPoint, setPointLevel, getPointLevel, getCurrentPoint, getMemberBasicInfo, setLoveLevel,
  checkAndApplyDiscount,
  calcExpectedPoints, getMailRows, getBankHistory, checkPointDiff,
  formatCampaignInfo,
  runPaymentCommand,
} = require('./utils');
const { sendSlack, isSlackOnly } = require('./slack-notify');

const LOGIN_URL  = process.env.SYSTEM_URL || 'http://manager.x7j4l2p9m1.com/mg/mg_ope.php';
const BASE_URL   = LOGIN_URL.replace(/[^/]+$/, ''); // "http://manager.x7j4l2p9m1.com/mg/"
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DRY_RUN    = process.env.DRY_RUN === 'true';

const CONTACT_TEMPLATES_PATH = path.join(__dirname, 'contact-templates.json');
const claudeClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// reply-checker.js と同じstate fileを共有する（同時稼働はしない前提）
const STATE_FILE = '/tmp/rune-reply-state.json';
const POLL_INTERVAL_MS = 2000;
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

// ─── LINE 返信待ち（ファイルポーリング）─────────────────────────────

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
    }, POLL_INTERVAL_MS);
  });
}

// ─── 処理コマンド解析 ─────────────────────────────────────────────
// 「開始」「開始#補足」「テンプレート{番号}」「スキップ」「〇pt追加」「〇pt減算」
// 「レベル変更:〇」「メール確認」「決済確認」「絆変更:{キャラID}:{value}」
// 「{uid} {金額}円 入金」および上記の組み合わせ
// （例:「メール確認 決済確認 開始」）に対応する。
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
    template:   (m => (m ? parseInt(m[1], 10) : null))(body.match(/テンプレート(\d+)/)),
    payment:    (m => (m ? { uid: m[1], amount: parseInt(m[2].replace(/,/g, ''), 10) } : null))(body.match(/(\d+)\s+([\d,]+)円\s*入金/)),
    mail:       body.includes('メール確認'),
    bank:       body.includes('決済確認'),
    skip:       body.includes('スキップ'),
    love:       (m => (m ? { charaId: m[1], value: m[2] } : null))(body.match(/絆変更:(\d+):(\d+)/)),
  };
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
      // getBankHistory()はお知らせメール一覧から会員詳細へ戻る前提で
      // window.history.back()を実行するため、戻り先が無くならないよう
      // 同じURLをもう一度開いて履歴を1つ積んでおく
      await kyouseiPage.goto(kyouseiPage.url());
      await kyouseiPage.waitForLoadState('networkidle');

      const { paymentRows, historyPage: hp } = await getBankHistory(page, kyouseiPage);
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
      const mailRows = await getMailRows(kyouseiPage);
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
const COMMAND_HELP_LINES = [
  '「開始」：AIで返答を自動生成',
  '「開始#補足」：補足を踏まえてAIで返答を自動生成',
  '「テンプレート{番号}」：指定番号のテンプレートで返答',
  '「スキップ」：このユーザーをスキップ',
  '「{数値}pt追加」「{数値}pt減算」：ポイント増減のみ',
  '「レベル変更:{数値}」：レベル変更のみ',
  '「メール確認」：当日配信メールを通知',
  '「決済確認」：当日決済履歴を通知',
  '「絆変更:{キャラID}:{value}」：絆レベル変更のみ',
  '「{uid} {金額}円 入金」：手動で入金処理を実行',
  '（例）「メール確認 決済確認 開始」',
];

// contact-templates.json のテンプレート一覧を「番号: id」形式で返す
// （「テンプレート{番号}」コマンドで指定できるよう問い合わせ受信時に表示する）
function buildTemplateListLines() {
  try {
    const templates = JSON.parse(fs.readFileSync(CONTACT_TEMPLATES_PATH, 'utf8')).templates;
    return ['【テンプレート一覧】', ...templates.map((t, i) => `${i + 1}: ${t.id}`)];
  } catch (e) {
    console.log('[TEMPLATE] テンプレート一覧の読み込みに失敗:', e.message);
    return [];
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
// 各メールの本文（td.bodyNaibu）にキャンペーンのコメントアウトがある場合は
// campaign-rules/campaign1.jsonから内容を引いて併記する
async function notifyTodayMails(page, uid) {
  if (!uid) {
    await sendLine('【エラー】会員IDが取得できず、メール確認を実行できませんでした');
    return;
  }
  let kyouseiPage = null;
  try {
    kyouseiPage = await openKyouseitaikai(page, uid);
    const mailRows = await getMailRows(kyouseiPage);
    console.log(`[MAIL-CHECK] uid=${uid}: 当日配信メール ${mailRows.length}件`);
    if (mailRows.length === 0) {
      await sendLine('【当日配信メール】\n当日配信されたお知らせメールはありませんでした');
      return;
    }
    const lines = ['【当日配信メール】'];
    for (const row of mailRows) {
      const campaignText = formatCampaignInfo(row.campaign);
      lines.push(row.title || '（タイトルなし）');
      lines.push(`キャンペーン：${campaignText || 'キャンペーンなし'}`);
    }
    await sendLine(lines.join('\n'));
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

// ─── 1コマンド分の照会・更新系処理をまとめて実行する ─────────────────
// 「開始」「スキップ」以外のコマンド（メール確認/決済確認/絆変更/
// ポイント追加/レベル変更）を受け取った順序どおりに処理する
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

// ─── Playwright: ログイン ─────────────────────────────────────────

async function login(page) {
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
  console.log('[LOGIN] タイトル:', await page.title());

  // セッション切れ対応（reply-checker.js と同じ方法）
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

// ─── STEP1: mg_contactMail.php を開く ───────────────────────────────
// リンクのクリックは不安定なため、直接URLへ遷移する

async function openContactMailPage(page) {
  const url = BASE_URL + 'mg_contactMail.php';
  console.log(`[STEP1] mg_contactMail.php を開く: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle' });
  return page;
}

// ─── STEP2: 「実行」ボタンをクリック ─────────────────────────────────

async function runContactSearch(contactPage) {
  console.log('[STEP2] 「実行」ボタンをクリック');
  await contactPage.click('input[type="submit"][value="実行"]');
  await contactPage.waitForLoadState('networkidle').catch(() => {});
  await new Promise(r => setTimeout(r, 1000));
}

// ─── STEP3: 未処理一覧（background-color: #ffaaaa の行）を取得 ────────
// 列は1始まりの表記に対応: 2列目=受信日時、3列目=会員ID、
// 4列目=ユーザーネーム（aタグ）、7列目=問い合わせ文頭、8列目=スレッド確認リンク

async function getUnprocessedContacts(contactPage) {
  const contacts = await contactPage.evaluate(() => {
    function normStyle(el) {
      return (el.getAttribute('style') || '').replace(/\s/g, '').toLowerCase();
    }

    const results = [];
    for (const tr of document.querySelectorAll('tr')) {
      const cells = Array.from(tr.querySelectorAll('td'));
      if (cells.length < 8) continue;

      const trIsPink = normStyle(tr).includes('background-color:#ffaaaa');
      const cellIsPink = cells.some(td => normStyle(td).includes('background-color:#ffaaaa'));
      if (!trIsPink && !cellIsPink) continue;

      const datetime = (cells[1].textContent || '').trim(); // 2列目
      const uid = (cells[2].textContent || '').trim();      // 3列目
      const userLink = cells[3].querySelector('a');          // 4列目のaタグ
      const username = userLink ? userLink.textContent.trim() : (cells[3].textContent || '').trim();
      const preview = (cells[6].textContent || '').trim();   // 7列目
      const threadLink = cells[7].querySelector('a');         // 8列目のaタグ
      const threadHref = threadLink ? threadLink.getAttribute('href') : null;
      if (!threadHref) continue;

      results.push({ datetime, uid, username, preview, threadHref });
    }
    return results;
  });

  console.log(`[STEP3] 未処理行数: ${contacts.length}`);
  contacts.forEach((c, i) => console.log(`[DEBUG] contact[${i}]: uid=${c.uid} username=${c.username} datetime=${c.datetime} threadHref=${c.threadHref}`));
  return contacts;
}

// ─── STEP4: mg_contact_edit.php（スレッド確認ページ）を新しいページで開く ──
// スレッド確認ページの遷移先は mg_contact_edit.php?uid={uid} であるため、
// そのURLを直接新しいページとして開く

async function openContactThread(contactPage, uid) {
  const url = `${BASE_URL}mg_contact_edit.php?uid=${encodeURIComponent(uid)}`;
  console.log(`[STEP4] mg_contact_edit.php を新しいページで開く: ${url}`);

  const threadPage = await contactPage.context().newPage();
  await threadPage.goto(url, { waitUntil: 'networkidle' }).catch(async () => {
    await threadPage.goto(url).catch(() => {});
  });

  console.log('[STEP4] 遷移後URL:', threadPage.url());
  return threadPage;
}

// STEP4で開いたthreadPage（mg_contact_edit.php）から全メッセージ本文を取得する。
// background-color: #aaaaffのtr内のtextarea（name="mess[...]"）から
// 各メッセージの本文を取得し、"---"区切りで連結する
async function getLatestThreadMessage(page, previewText) {
  try {
    const inquiries = await page.evaluate(() => {
      const rows = document.querySelectorAll('tr[style*="aaaaff"]');
      return Array.from(rows).map(tr => {
        const textarea = tr.querySelector('textarea[name^="mess["]');
        return textarea ? textarea.value.trim() : '';
      }).filter(t => t.length > 0);
    });
    if (inquiries.length > 0) {
      const fullText = inquiries.join('\n---\n');
      console.log(`[STEP4] スレッド本文取得: ${inquiries.length}件 "${fullText.slice(0, 60)}..."`);
      return fullText;
    }
  } catch (e) {
    console.log('[STEP4] 問い合わせ内容の取得に失敗:', e.message);
  }
  console.log('[STEP4] 本文取得に失敗/0件 → 一覧の問い合わせ文頭にフォールバック');
  return previewText;
}

// 指定した候補セレクターを順に試し、最初に見つかった要素に入力する。
// 特定のセレクターがタイムアウトするケースに備え、代替セレクターへ
// フォールバックする。1候補あたりの待機は短めにして無駄なタイムアウトの
// 積み重ねを防ぐ
async function fillFirstAvailable(page, selectors, value, timeoutPerSelector = 5000) {
  for (const sel of selectors) {
    try {
      const locator = page.locator(sel).first();
      await locator.waitFor({ state: 'visible', timeout: timeoutPerSelector });
      await locator.fill(value);
      console.log(`[STEP8] セレクター "${sel}" に入力成功`);
      return true;
    } catch (e) {
      console.log(`[STEP8] セレクター "${sel}" が見つからずタイムアウト → 次候補`);
    }
  }
  return false;
}

// ─── STEP7で使う送信本文の組み立て ────────────────────────────────

function buildContactReplyBody(answerText) {
  return [
    'お問い合わせ頂きました内容についての回答をさせて頂きます。',
    answerText,
    'その他、ご不明な点やご質問など御座いましたらお気軽にお問合せ窓口までお問い合わせ下さい。',
    'RUNEお問い合わせ窓口',
  ].join('\n');
}

// ─── HTML本文からキャンペーン内容を抽出・解析（support-checker.js の ────
// parseCampaignWithClaude と同じロジック、claudeClientを使用）
const CAMPAIGN_SYSTEM_PROMPT =
  'あなたはメール本文からキャンペーン情報を抽出するアシスタントです。JSONのみで回答してください。';

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
    const response = await claudeClient.messages.create({
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

// ─── STEP4.5: uidのキャンペーン・入金状況を確認し割引率/ポイント差異をチェック ──
// support-checker.jsのSTEP4-6(お知らせメール取得)・STEP11-14(銀行振込履歴取得)・
// STEP15(ポイント差異チェック)・checkAndApplyDiscountと同じ処理をuidベースで行う。
// 割引率調整・ポイント差異調整で実在ユーザーの所持ポイント・レベルを変更する
// ため、DRY_RUN=trueの間は銀行振込履歴取得以降を一切実行しない
// 戻り値: { discountChanged, fromLevel, toLevel, pointAdjusted, pointAmount, pointSign }
// （AI返答生成プロンプトに実施した対応を反映するために使う）
async function checkCampaignAndPoints(page, contact) {
  const result = {
    discountChanged: false, fromLevel: null, toLevel: null,
    pointAdjusted: false, pointAmount: 0, pointSign: null,
  };

  let kyouseiPage;
  try {
    kyouseiPage = await openKyouseitaikai(page, contact.uid);
  } catch (e) {
    console.log(`[CAMPAIGN] uid=${contact.uid}: 会員詳細ページを開けませんでした: ${e.message}`);
    return result;
  }

  try {
    const mailRows = await getMailRows(kyouseiPage);
    console.log(`[CAMPAIGN] uid=${contact.uid}: 本日配信メール ${mailRows.length}件`);
    if (mailRows.length === 0) return result;

    const mails = [];
    for (let i = 0; i < mailRows.length; i++) {
      const row = mailRows[i];
      const campaigns = await parseCampaignWithClaude(row.bodyHtml);
      console.log(`[CAMPAIGN] uid=${contact.uid} メール${i + 1} "${row.title}": ${campaigns.length}件検出`);
      mails.push({ title: row.title || `メール${i + 1}`, campaigns });
    }
    const allCampaigns = mails.flatMap(m => m.campaigns);
    if (allCampaigns.length === 0) return result;

    if (DRY_RUN) {
      console.log(`[DRY RUN] uid=${contact.uid}: 銀行振込履歴取得・割引/ポイント差異チェックをスキップ`);
      return result;
    }

    const { paymentRows, actionRows, manualRows, historyPage, couponLevel } = await getBankHistory(page, kyouseiPage);
    console.log(`[CAMPAIGN] uid=${contact.uid}: 銀行振込履歴 ${paymentRows.length}件`);
    if (paymentRows.length === 0) return result;

    const totalAmount = paymentRows.reduce((sum, r) => sum + r.amount, 0);

    // ─── 割引率調整 ──────────────────────────────────────────
    try {
      const discountResult = await checkAndApplyDiscount(page, contact.uid, allCampaigns, totalAmount, sendLine, waitForLineReply, DRY_RUN);
      if (discountResult?.changed) {
        result.discountChanged = true;
        result.fromLevel = discountResult.fromLevel;
        result.toLevel = discountResult.toLevel;
      }
    } catch (e) {
      console.log(`[DISCOUNT] uid=${contact.uid}: 割引率チェックに失敗: ${e.message}`);
    }

    // ─── ポイント調整 ────────────────────────────────────────
    const { diff, reply } = await checkPointDiff(allCampaigns, paymentRows, sendLine, waitForLineReply, DRY_RUN, couponLevel, actionRows, manualRows);
    if (diff !== 0 && reply === '調整する') {
      if (historyPage !== kyouseiPage) {
        await historyPage.close().catch(() => {});
      } else {
        await kyouseiPage.evaluate(() => window.history.back());
        await new Promise(r => setTimeout(r, 2000));
      }
      const sign = diff < 0 ? '+' : '-';
      const diffAbs = Math.abs(diff);
      const adjustPage = await openKyouseitaikai(page, contact.uid);
      await adjustPoint(adjustPage, diffAbs, sign);
      await adjustPage.close();
      await sendLine(`【調整完了】uid=${contact.uid}のポイントを${sign}${diffAbs}pt調整しました`);
      result.pointAdjusted = true;
      result.pointAmount = diffAbs;
      result.pointSign = sign;
    }
  } catch (e) {
    console.log(`[CAMPAIGN] uid=${contact.uid}: キャンペーン/ポイントチェックに失敗: ${e.message}`);
  } finally {
    await kyouseiPage.close().catch(() => {});
  }

  return result;
}

// ─── STEP4.7: テンプレート該当なし時、Claude APIで返答文を自動生成する ──
// 生成失敗時はnullを返し、呼び出し側は既存の手動対応フローへ進む
// adjustments: checkCampaignAndPoints()の戻り値。割引率・ポイント調整を
// 実施済みの場合、その内容をプロンプトに含めて返答文に反映させる
async function generateReplyWithClaude(inquiryText, adjustments, supplement = null) {
  const actionLines = [];
  if (adjustments?.discountChanged) {
    actionLines.push(`・割引率を${adjustments.fromLevel}→${adjustments.toLevel}に変更しました`);
  }
  if (adjustments?.pointAdjusted) {
    actionLines.push(`・${adjustments.pointAmount}ptを追加しました`);
  }

  let userPrompt = actionLines.length > 0
    ? `以下のユーザーからの問い合わせに対して返答文を生成してください。

問い合わせ内容：${inquiryText}

実施した対応：
${actionLines.join('\n')}

上記の対応を踏まえた上で、ユーザーへの返答文を生成してください。
対応済みの内容を反映した文章にしてください。`
    : `以下のユーザーからの問い合わせに対して返答文を生成してください。\n問い合わせ内容：${inquiryText}`;

  if (supplement) {
    userPrompt += `\n\nオペレーターからの補足指示：${supplement}\nこの補足も踏まえて返答文を生成してください。`;
  }

  const response = await claudeClient.messages.create({
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

// STEP8 / 自動返答で共通の送信処理（本文を入力してgotoHeavenをクリック）
// 件名は本文の1行目が自動的に使われるため、件名欄への入力は行わない
// 成功時はtrue、失敗時はfalseを返す
async function submitContactReply(threadPage, bodyText, uid, label) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] ${label}送信をスキップ: uid=${uid}`);
    await sendLine(`【DRY RUN】uid=${uid}への${label}送信をスキップしました`);
    return true;
  }

  console.log('[DEBUG] 送信前URL:', threadPage.url());

  // mg_contact_edit.phpはiframe構成で、返信フォーム（messTempBody /
  // gotoHeaven）とメッセージ履歴（#aaaaff）が別々のiframeにある。
  // threadPage直下には無いため、フォームを持つiframeを探して操作する
  const frames = threadPage.frames();
  let formFrame = null;
  for (const frame of frames) {
    const hasForm = await frame.locator('textarea#messTempBody').count().catch(() => 0);
    if (hasForm > 0) {
      formFrame = frame;
      break;
    }
  }
  if (!formFrame) {
    throw new Error('返信フォームのiframeが見つかりません');
  }

  await formFrame.fill('textarea#messTempBody', bodyText);
  await formFrame.click('input#gotoHeaven');
  await threadPage.waitForLoadState('networkidle').catch(() => {});
  console.log(`[SEND] uid=${uid} ${label}送信完了`);
  await sendLine(`【送信完了】uid=${uid}へ${label}を送信しました`);
  return true;
}

// ─── コンタクト処理メインループ ───────────────────────────────────

async function processContacts(page) {
  const contactPage = await openContactMailPage(page);
  await runContactSearch(contactPage);
  const contacts = await getUnprocessedContacts(contactPage);
  console.log(`[LIST] 未処理コンタクト: ${contacts.length}件`);

  if (contacts.length === 0) {
    await sendLine('未処理のコンタクトメールはいませんでした');
    return;
  }

  for (const contact of contacts) {
    if (_shouldStop) {
      console.log('[STOP] 停止要求により中断');
      break;
    }

    console.log(`[CONTACT] 確認中: uid=${contact.uid} username=${contact.username}`);

    // ─── STEP4 ──────────────────────────────────────────────────
    // 新しいページとして開くため、処理後は必ずclose()する（try/finally）
    const threadPage = await openContactThread(contactPage, contact.uid);
    try {
      const content = await getLatestThreadMessage(threadPage, contact.preview);

      // ─── 問い合わせ内容を先にLINEへ表示し、処理コマンドを待つ ──────
      // 「メール確認」「決済確認」等の照会コマンドを受けた場合は次のユーザーへ
      // 進まず、結果を確認したうえで再度コマンドを入力できるようにする
      // 会員基本情報（【会員情報】）は常時取得する。
      // ポイント関連の問い合わせのみポイント照合（【ポイント照合】）も取得する。
      const basicInfoLines = await collectMemberBasicInfo(page, contact.uid);
      let memberInfoLines = [];
      if (needsMemberInfo(content)) {
        memberInfoLines = await collectMemberInfo(page, contact.uid);
      } else {
        console.log(`[MEMBER-INFO] uid=${contact.uid}: ポイント関連キーワードなし → ポイント照合の取得をスキップ`);
      }

      let cmd = null;
      let timedOut = false;
      let firstPrompt = true;
      while (true) {
        await sendLine(firstPrompt
          ? [
              '【問い合わせ受信】',
              `会員ID：${contact.uid}`,
              `ユーザー：${contact.username}`,
              `受信日時：${contact.datetime}`,
              '---',
              content,
              '---',
              ...(basicInfoLines.length > 0 ? [...basicInfoLines, ''] : []),
              ...(memberInfoLines.length > 0 ? [...memberInfoLines, ''] : []),
              ...buildTemplateListLines(),
              '',
              '処理コマンドを入力してください：',
              ...COMMAND_HELP_LINES,
            ].join('\n')
          : [
              '【コマンド待ち】',
              `ユーザー：${contact.username}`,
              '続けて処理コマンドを入力してください：',
              ...COMMAND_HELP_LINES,
            ].join('\n'));
        firstPrompt = false;

        let reply;
        try {
          reply = await waitForLineReply();
        } catch (e) {
          console.log(`[TIMEOUT] uid=${contact.uid}: 処理コマンド待ち タイムアウト → スキップ`);
          timedOut = true;
          break;
        }
        console.log(`[LINE] 処理コマンド返信: ${reply}`);

        const parsed = parseCommand(reply);

        // 照会・更新系コマンド（メール確認/決済確認/絆変更/ポイント/レベル）を実行
        await runSubCommands(page, contact.uid, parsed);

        // 照会・入金コマンドが含まれ、かつ「開始」「テンプレート」「スキップ」の
        // 指示がなければ、結果を確認したうえで次のコマンドを入力できるよう
        // コマンド待ちに戻る
        if ((parsed.mail || parsed.bank || parsed.payment) && !parsed.start && !parsed.template && !parsed.skip) {
          console.log(`[CMD] uid=${contact.uid}: 照会/入金コマンドのみ → 再度コマンド待ちへ`);
          continue;
        }

        cmd = { ...parsed, reply };
        break;
      }
      if (timedOut) continue;

      const { start: startMatch, supplement, template: templateNum } = cmd;
      const startReply = cmd.reply;

      // ─── STEP4.6a: 「テンプレート{番号}」指定時は該当テンプレートで返答 ──
      // テンプレートの自動照合は廃止し、番号による明示指定のみを受け付ける
      if (templateNum) {
        const templates = JSON.parse(fs.readFileSync(CONTACT_TEMPLATES_PATH, 'utf8')).templates;
        const template = templates[templateNum - 1];
        if (!template) {
          console.log(`[TEMPLATE] uid=${contact.uid}: テンプレート${templateNum}は存在しません`);
          await sendLine(`【エラー】テンプレート${templateNum}は存在しません（1〜${templates.length}で指定してください）`);
          continue;
        }
        await sendLine([
          '【テンプレート返答候補】',
          `テンプレート${templateNum}：${template.id}`,
          '---',
          template.response,
          '---',
          '「送信」：そのまま送信',
          '「スキップ」：手動対応へ',
        ].join('\n'));

        let tReply = null;
        try {
          tReply = await waitForLineReply();
        } catch (e) {
          console.log(`[TIMEOUT] uid=${contact.uid}: テンプレート確認 5分タイムアウト → 次のユーザーへ`);
          continue;
        }
        console.log(`[LINE] テンプレート確認返信: ${tReply}`);

        if (tReply === '送信') {
          await submitContactReply(threadPage, template.response, contact.uid, `テンプレート${templateNum}（${template.id}）`);
        } else {
          console.log(`[TEMPLATE] uid=${contact.uid}: テンプレート送信をスキップ`);
        }
        continue;
      }

      // 3. 「開始」がなければ（スキップ含む）次のユーザーへ
      if (!startMatch) {
        console.log(`[SKIP] uid=${contact.uid}: 開始/テンプレートコマンドなし（reply="${startReply}"）→ 次のユーザーへ`);
        continue;
      }

      // ─── STEP4.5: キャンペーン・ポイント確認（割引率調整→ポイント調整） ──
      // 問い合わせ内容にポイント関連キーワードが含まれる場合のみ実行する
      let campaignResult = null;
      const pointKeywords = ['ポイント', 'pt', 'PT', '割引', 'キャンペーン', '入金', '購入', '反映'];
      const hasPointRelated = pointKeywords.some(k => content.includes(k));
      if (hasPointRelated) {
        console.log(`[CAMPAIGN] uid=${contact.uid}: ポイント関連キーワード検出 → STEP4.5を実行`);
        try {
          campaignResult = await checkCampaignAndPoints(page, contact);
        } catch (e) {
          console.log(`[CAMPAIGN] uid=${contact.uid}: STEP4.5に失敗: ${e.message}`);
        }
      } else {
        console.log(`[CAMPAIGN] uid=${contact.uid}: ポイント関連キーワードなし → STEP4.5をスキップ`);
      }

      // ─── STEP4.6b: 「開始」→ Claude APIで返答文を自動生成 ─────────
      // テンプレート自動照合は廃止したため、開始コマンドは常にAI生成を行う。
      // STEP4.5で実施した割引率・ポイント調整の内容・補足をプロンプトに反映する
      {
        let aiReplyText = null;
        try {
          aiReplyText = await generateReplyWithClaude(content, campaignResult, supplement);
        } catch (e) {
          console.log(`[AI-REPLY] uid=${contact.uid}: 返答文生成に失敗: ${e.message}`);
        }

        if (aiReplyText) {
          await sendLine([
            '【AI生成返答】',
            '---',
            aiReplyText,
            '---',
            '「送信」：そのまま送信',
            '「スキップ」：手動対応へ',
            '「差し替え#文章」：内容を変更して送信',
          ].join('\n'));

          let aiReply = null;
          try {
            aiReply = await waitForLineReply();
          } catch (e) {
            console.log(`[TIMEOUT] uid=${contact.uid}: AI生成返答確認 5分タイムアウト → 手動対応へ`);
          }
          console.log(`[LINE] AI生成返答確認返信: ${aiReply}`);

          if (aiReply === '送信') {
            await submitContactReply(threadPage, aiReplyText, contact.uid, 'AI生成返答');
            continue;
          } else if (aiReply && aiReply.startsWith('差し替え#')) {
            const replacedText = aiReply.replace(/^差し替え#/, '').trim();
            await submitContactReply(threadPage, replacedText, contact.uid, 'AI生成返答（差し替え）');
            continue;
          }
          console.log(`[AI-REPLY] uid=${contact.uid}: AI生成返答をスキップ → 手動対応フローへ`);
        }
      }

      // ─── STEP5 ────────────────────────────────────────────────
      await sendLine([
        '【コンタクトメール】',
        `会員ID：${contact.uid}`,
        `ユーザー：${contact.username}`,
        `受信日時：${contact.datetime}`,
        '---',
        content,
        '---',
        '返答内容を入力してください',
        '（スキップする場合は「スキップ」）',
      ].join('\n'));

      // ─── STEP6 ────────────────────────────────────────────────
      let answer;
      try {
        answer = await waitForLineReply();
      } catch (e) {
        console.log(`[TIMEOUT] uid=${contact.uid}: 5分タイムアウト → スキップ`);
        continue;
      }
      console.log(`[LINE] 返答内容: ${answer}`);

      if (answer === 'スキップ') {
        console.log(`[SKIP] uid=${contact.uid} スキップ`);
        continue;
      }

      // ─── STEP7 ────────────────────────────────────────────────
      const bodyText = buildContactReplyBody(answer);
      await sendLine([
        '【送信確認】',
        '---',
        '件名：RUNEインフォメーションです。',
        '',
        '本文：',
        bodyText,
        '---',
        '「送信」または「スキップ」',
      ].join('\n'));

      let confirmReply;
      try {
        confirmReply = await waitForLineReply();
      } catch (e) {
        console.log(`[TIMEOUT] uid=${contact.uid}: 送信確認 5分タイムアウト → スキップ`);
        continue;
      }
      console.log(`[LINE] 送信確認返信: ${confirmReply}`);

      if (confirmReply !== '送信') {
        console.log(`[SKIP] uid=${contact.uid} 送信確認でスキップ`);
        continue;
      }

      // ─── STEP8 ────────────────────────────────────────────────
      await submitContactReply(threadPage, bodyText, contact.uid, '返答');
    } finally {
      await threadPage.close().catch(() => {});
    }
  }
}

// ─── エントリポイント ─────────────────────────────────────────────

function stopContacts() {
  _shouldStop = true;
  console.log('=== contact-checker 停止要求 ===');
}

async function checkContacts() {
  _shouldStop = false;
  console.log('=== contact-checker 起動 ===');

  if (DRY_RUN) console.log('[DRY RUN] モード有効');
  clearState();

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    httpCredentials: {
      username: process.env.BASIC_AUTH_ID,
      password: process.env.BASIC_AUTH_PASS,
    },
  });

  try {
    const page = await context.newPage();
    await login(page);
    await processContacts(page);
    console.log('=== contact-checker 完了 ===');
  } catch (err) {
    console.error('[FATAL]', err.message, err.stack);
    await sendLine(`【システムエラー】contact-checker: ${err.message}`);
  } finally {
    clearState();
    await browser.close();
  }
}

if (require.main === module) {
  checkContacts();
}

module.exports = { checkContacts, stopContacts };

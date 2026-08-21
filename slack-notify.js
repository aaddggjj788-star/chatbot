/**
 * Slack通知の共通モジュール
 *
 * reply-checker.js / contact-checker.js / support-checker.js / mail-checker.js は、
 * それぞれがローカルに sendLine() を持ちLINEのbroadcast APIを直接叩いている。
 * server.js から通知関数が渡される構造ではないため、Slackコマンドで起動しても
 * 進捗・結果の通知がSlackへ届かない状態になっていた。
 *
 * そこで各 sendLine() の先頭からこの sendSlack() を呼び、
 * さらに isSlackOnly() で LINE送信を行うかどうかを判定する。
 *
 * 【通知先の対応表】
 *   SLACK_ONLY=true  かつ SLACK_WEBHOOK_URL設定あり → Slackのみ
 *   SLACK_ONLY=false かつ SLACK_WEBHOOK_URL設定あり → LINE + Slack
 *   SLACK_WEBHOOK_URL未設定（コメントアウト含む）    → LINEのみ
 *
 * ・SLACK_WEBHOOK_URL が未設定なら sendSlack() は何もしない
 * ・SLACK_WEBHOOK_URL が未設定なら SLACK_ONLY の値に関わらず isSlackOnly() は
 *   false を返す（Slackにも送れずLINEも止まる＝通知が消える事故を防ぐため）
 * ・送信に失敗してもエラーを投げない（LINE通知やチェック処理を止めないため）
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const axios = require('axios');

// Slackの1メッセージ上限（40000文字）に対する安全マージン
const MAX_LEN = 39000;

// Slack通知の失敗でチェック処理やLINE通知が止まらないよう、
// タイムアウトを短めにし、例外は内部で握りつぶす
const TIMEOUT_MS = 5000;

// Slackへの通知が有効か（SLACK_WEBHOOK_URLが設定されているか）
function isSlackEnabled() {
  return Boolean(process.env.SLACK_WEBHOOK_URL);
}

// LINE送信をスキップしてSlackのみに通知するか
// ※SLACK_WEBHOOK_URL未設定時は、SLACK_ONLY=trueでも false を返す。
//   Slackにも送れない状態でLINEまで止めると通知が完全に消えてしまうため。
function isSlackOnly() {
  return process.env.SLACK_ONLY === 'true' && isSlackEnabled();
}

async function sendSlack(message) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;

  const raw = typeof message === 'string' ? message : String(message ?? '');
  if (!raw.trim()) return;

  const text = raw.length > MAX_LEN
    ? `${raw.slice(0, MAX_LEN)}\n（以降は文字数上限のため省略）`
    : raw;

  try {
    await axios.post(
      url,
      { text },
      { headers: { 'Content-Type': 'application/json' }, timeout: TIMEOUT_MS }
    );
  } catch (err) {
    console.error('[SLACK] 通知エラー:', err.message);
  }
}

module.exports = { sendSlack, isSlackOnly, isSlackEnabled };

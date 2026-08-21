/**
 * Slack通知の共通モジュール
 *
 * reply-checker.js / contact-checker.js / support-checker.js は、それぞれが
 * ローカルに sendLine() を持ちLINEのbroadcast APIを直接叩いている。
 * server.js から通知関数が渡される構造ではないため、Slackコマンドで起動しても
 * 進捗・結果の通知がSlackへ届かない状態になっていた。
 *
 * そこで各 sendLine() の先頭からこの sendSlack() を呼び、
 * LINE通知に「加えて」同じ内容をSlackへも送る。
 *
 * ・SLACK_WEBHOOK_URL が未設定なら何もしない（未設定環境では完全に無影響）
 * ・送信に失敗してもエラーを投げない（LINE通知やチェック処理を止めないため）
 * ・LINE送信の処理には一切関与しない（既存のLINE通知の挙動は変更しない）
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const axios = require('axios');

// Slackの1メッセージ上限（40000文字）に対する安全マージン
const MAX_LEN = 39000;

// Slack通知の失敗でチェック処理やLINE通知が止まらないよう、
// タイムアウトを短めにし、例外は内部で握りつぶす
const TIMEOUT_MS = 5000;

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

module.exports = { sendSlack };

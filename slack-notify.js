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
const fs = require('fs');
const path = require('path');

const NOTIFY_MODE_FILE = path.join(
  __dirname,
  'notify-mode.json'
);

// LINE / Slack の通知先を取得
function getNotifyMode() {
  try {
    if (fs.existsSync(NOTIFY_MODE_FILE)) {
      const data = JSON.parse(
        fs.readFileSync(NOTIFY_MODE_FILE, 'utf8')
      );

      if (data.mode === 'line' || data.mode === 'slack') {
        return data.mode;
      }
    }
  } catch (err) {
    console.error('[NOTIFY] 設定読込失敗:', err.message);
  }

  // 初期設定は従来の.envを引き継ぐ
  if (
    process.env.SLACK_ONLY === 'true' &&
    process.env.SLACK_WEBHOOK_URL
  ) {
    return 'slack';
  }

  return 'line';
}

// 通知先を保存
function setNotifyMode(mode) {
  if (!['line', 'slack'].includes(mode)) {
    throw new Error('通知先はlineまたはslackを指定してください');
  }

  if (mode === 'slack' && !process.env.SLACK_WEBHOOK_URL) {
    throw new Error('Slack Webhook URLが未設定です');
  }

  fs.writeFileSync(
    NOTIFY_MODE_FILE,
    JSON.stringify({ mode }, null, 2),
    'utf8'
  );

  console.log(`[NOTIFY] 通知先を${mode}に変更`);
  return mode;
}

function isLineOnly() {
  return getNotifyMode() === 'line';
}

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
  return getNotifyMode() === 'slack' && isSlackEnabled();
}

async function sendSlack(message) {
  if (isLineOnly()) return;
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;

  const raw = typeof message === 'string' ? message : String(message ?? '');
  if (!raw.trim()) return;

  const separator = '\n\n────────────────────────';

  const maxBodyLen = MAX_LEN - separator.length;
  const textBody = raw.length > maxBodyLen
    ? `${raw.slice(0, maxBodyLen - 20)}\n（以降は省略）`
    : raw;

  const text = textBody + separator;

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

// ======================================================
// Slack画像送信（ポイント履歴などのPNG証跡用）
// ======================================================
async function sendSlackImage(imagePath, message = '') {
  if (isLineOnly()) {
    console.log('[SLACK-IMAGE] LINE専用モードのため送信省略');
    return false;
  }
  const token = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_IMAGE_CHANNEL_ID;

  if (!token || !channelId) {
    console.error(
      '[SLACK-IMAGE] Bot TokenまたはチャンネルIDが未設定'
    );
    return false;
  }

  if (!imagePath || !fs.existsSync(imagePath)) {
    console.error(
      `[SLACK-IMAGE] 画像ファイルなし: ${imagePath}`
    );
    return false;
  }

  try {
    const filename = path.basename(imagePath);
    const buffer = fs.readFileSync(imagePath);
    const headers = {
      Authorization: `Bearer ${token}`
    };

    // ① Slackからアップロード先URLを取得
    const ticket = await axios.post(
      'https://slack.com/api/files.getUploadURLExternal',
      null,
      {
        headers,
        params: {
          filename,
          length: buffer.length
        },
        timeout: 15000
      }
    );

    if (!ticket.data?.ok) {
      throw new Error(
        `アップロードURL取得失敗: ${ticket.data?.error}`
      );
    }

    // ② 取得したURLへPNGデータをアップロード
    await axios.post(
      ticket.data.upload_url,
      buffer,
      {
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        maxBodyLength: Infinity,
        timeout: 60000
      }
    );

    // ③ アップロードを確定し、チャンネルへ共有
    const completed = await axios.post(
      'https://slack.com/api/files.completeUploadExternal',
      {
        files: [
          {
            id: ticket.data.file_id,
            title: filename
          }
        ],
        channel_id: channelId,
        initial_comment: String(message || '')
      },
      {
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    if (!completed.data?.ok) {
      throw new Error(
        `アップロード確定失敗: ${completed.data?.error}`
      );
    }

    console.log(
      `[SLACK-IMAGE] 送信完了: ${filename}`
    );

    return true;

  } catch (err) {
    console.error(
      `[SLACK-IMAGE] 送信失敗: ${err.message}`
    );

    return false;
  }
}

module.exports = {
  sendSlack,
  sendSlackImage,
  isSlackOnly,
  isSlackEnabled,
  getNotifyMode,
  setNotifyMode,
  isLineOnly
};

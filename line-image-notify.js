'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isSlackOnly } = require('./slack-notify');

async function sendLinePointHistoryImage(imagePath, uid) {
  if (isSlackOnly()) {
    console.log('[LINE-IMAGE] Slack専用モードのため送信省略');
    return false;
  }
  const origin = process.env.LINE_IMAGE_BASE_URL;
  const secret = process.env.LINE_IMAGE_SIGNING_SECRET;
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  if (!origin || !secret || !token) {
    console.error('[LINE-IMAGE] 環境変数が不足しています');
    return false;
  }

  if (!/^https:\/\//.test(origin)) {
    console.error('[LINE-IMAGE] HTTPS URLが必要です');
    return false;
  }

  if (!fs.existsSync(imagePath)) {
    console.error('[LINE-IMAGE] 画像ファイルがありません');
    return false;
  }

  const filename = path.basename(imagePath);

  // まずは元画像をプレビューにも使用
  // 1MBを超える画像は別途プレビュー生成が必要
  if (fs.statSync(imagePath).size > 1024 * 1024) {
    console.error('[LINE-IMAGE] プレビュー画像の1MB上限を超えています');
    return false;
  }

  // 画像URLの有効期限は1時間
  const payload = {
    uid: String(uid),
    filename,
    exp: Date.now() + 60 * 60 * 1000
  };

  const data = Buffer.from(
    JSON.stringify(payload)
  ).toString('base64url');

  const signature = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64url');

  const url = `${origin.replace(/\/$/, '')}/line-point-image/${data}.${signature}`;

  try {
    const response = await axios.post(
      'https://api.line.me/v2/bot/message/broadcast',
      {
        messages: [
          {
            type: 'image',
            originalContentUrl: url,
            previewImageUrl: url
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }

    console.log(`[LINE-IMAGE] 送信API成功 uid=${uid}`);
    return true;

  } catch (err) {
    console.error(
      '[LINE-IMAGE] 送信失敗:',
      err.response?.data || err.message
    );
    return false;
  }
}

module.exports = { sendLinePointHistoryImage };
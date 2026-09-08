const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const QUEUE_DIR = path.join(__dirname, 'generated-queue');
const ARCHIVE_DIR = path.join(QUEUE_DIR, 'archive');
const CURRENT_FILE = path.join(QUEUE_DIR, 'current.json');

function ensureDirs() {
  if (!fs.existsSync(QUEUE_DIR)) {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
  }

  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }
}

function getJstDate() {
  return new Date()
    .toLocaleDateString('en-CA', {
      timeZone: 'Asia/Tokyo'
    });
}

function getJstDatetime() {
  return new Date()
    .toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo'
    });
}

function createEmptyQueue() {
  return {
    date: getJstDate(),
    nextId: 1,
    items: []
  };
}

function writeQueue(queue) {
  ensureDirs();

  const tmpFile = `${CURRENT_FILE}.tmp`;

  fs.writeFileSync(
    tmpFile,
    JSON.stringify(queue, null, 2),
    'utf8'
  );

  fs.renameSync(tmpFile, CURRENT_FILE);
}

function archiveOldQueue(queue) {
  if (!queue || !queue.date) return;

  const archiveFile = path.join(
    ARCHIVE_DIR,
    `${queue.date}.json`
  );

  if (!fs.existsSync(archiveFile)) {
    fs.writeFileSync(
      archiveFile,
      JSON.stringify(queue, null, 2),
      'utf8'
    );
  }
}

function loadQueue() {
  ensureDirs();

  if (!fs.existsSync(CURRENT_FILE)) {
    const queue = createEmptyQueue();
    writeQueue(queue);
    return queue;
  }

  let queue;

  try {
    queue = JSON.parse(
      fs.readFileSync(CURRENT_FILE, 'utf8')
    );
  } catch (e) {
    console.error(
      '[GENERATED-QUEUE] current.json 読込失敗:',
      e.message
    );

    queue = createEmptyQueue();
    writeQueue(queue);

    return queue;
  }

  const today = getJstDate();

  // 日付が変わっていたら前日分をarchiveへ退避し、
  // 当日の生成リストを新しく開始する。
  if (queue.date !== today) {
    console.log(
      `[GENERATED-QUEUE] 日付変更 ${queue.date} → ${today}`
    );

    archiveOldQueue(queue);

    queue = createEmptyQueue();
    writeQueue(queue);
  }

  if (!Array.isArray(queue.items)) {
    queue.items = [];
  }

  if (!Number.isInteger(queue.nextId)) {
    const maxId = queue.items.reduce(
      (max, item) =>
        Math.max(max, Number(item.id) || 0),
      0
    );

    queue.nextId = maxId + 1;
  }

  return queue;
}

/**
 * 同じ対象を識別するキー。
 *
 * receivedAtだけではなく、
 * uid / kid / 本文も含めることで誤重複を防ぐ。
 */
function createSourceKey({
  source,
  uid,
  kid,
  receivedAt,
  userText
}) {
  const raw = [
    source || '',
    uid || '',
    kid || '',
    receivedAt || '',
    userText || ''
  ].join('|');

  return crypto
    .createHash('sha256')
    .update(raw)
    .digest('hex');
}

/**
 * 生成リストへ登録。
 *
 * 同一sourceKeyが当日のリストに既に存在する場合は
 * 新規登録せず既存項目を返す。
 */
function addGeneratedItem(data) {
  const queue = loadQueue();

  const sourceKey =
    data.sourceKey ||
    createSourceKey(data);

  const existing = queue.items.find(
    item => item.sourceKey === sourceKey
  );

  if (existing) {
    console.log(
      `[GENERATED-QUEUE] 重複のため追加しません ` +
      `id=${existing.id} status=${existing.status}`
    );

    return {
      created: false,
      item: existing
    };
  }

  const item = {
    id: queue.nextId++,

    source: data.source || 'unknown',

    uid: data.uid != null
      ? String(data.uid)
      : '',

    kid: data.kid != null
      ? String(data.kid)
      : '',

    userName: data.userName || '',

    receivedAt: data.receivedAt || '',

    sourceKey,

    reason: data.reason || '',

    decision:
      data.decision || null,

    replyDraft:
      data.replyDraft || data.generatedText || '',

    commands:
      Array.isArray(data.commands)
        ? data.commands
        : [],

    userText: data.userText || '',

    action: data.action || '',

    generatedText: data.generatedText || '',

    comment: data.comment || '',

    finalText:
      data.finalText ||
      [
        data.generatedText || '',
        data.comment || ''
      ]
        .filter(Boolean)
        .join('\n'),

    status: 'pending',

    generatedAt: getJstDatetime(),

    sentAt: null,

    skippedAt: null,

    errorAt: null,

    errorMessage: null
  };

  queue.items.push(item);

  writeQueue(queue);

  console.log(
    `[GENERATED-QUEUE] 登録 id=${item.id} ` +
    `source=${item.source} uid=${item.uid} ` +
    `reason=${item.reason}`
  );

  

  return {
    created: true,
    item
  };
}

function getGeneratedItem(id) {
  const queue = loadQueue();

  return (
    queue.items.find(
      item => Number(item.id) === Number(id)
    ) || null
  );
}

function listGeneratedItems({
  status = null,
  source = null
} = {}) {
  const queue = loadQueue();

  return queue.items.filter(item => {
    if (
      status &&
      item.status !== status
    ) {
      return false;
    }

    if (
      source &&
      item.source !== source
    ) {
      return false;
    }

    return true;
  });
}

function updateItemStatus(
  id,
  status,
  extra = {}
) {
  const queue = loadQueue();

  const item = queue.items.find(
    item => Number(item.id) === Number(id)
  );

  if (!item) {
    return null;
  }

  item.status = status;

  Object.assign(
    item,
    extra
  );

  writeQueue(queue);

  console.log(
    `[GENERATED-QUEUE] status変更 ` +
    `id=${id} → ${status}`
  );

  return item;
}

function markGeneratedItemSent(id) {
  return updateItemStatus(
    id,
    'sent',
    {
      sentAt: getJstDatetime()
    }
  );
}

function markGeneratedItemSkipped(id) {
  return updateItemStatus(
    id,
    'skipped',
    {
      skippedAt: getJstDatetime()
    }
  );
}

function markGeneratedItemError(
  id,
  message
) {
  return updateItemStatus(
    id,
    'error',
    {
      errorAt: getJstDatetime(),
      errorMessage:
        message != null
          ? String(message)
          : ''
    }
  );
}

function isAlreadyGenerated(data) {
  const queue = loadQueue();

  const sourceKey =
    data.sourceKey ||
    createSourceKey(data);

  return queue.items.some(
    item => item.sourceKey === sourceKey
  );
}

module.exports = {
  loadQueue,
  createSourceKey,

  addGeneratedItem,
  getGeneratedItem,
  listGeneratedItems,

  markGeneratedItemSent,
  markGeneratedItemSkipped,
  markGeneratedItemError,

  isAlreadyGenerated
};
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const QUEUE_DIR =
  path.join(__dirname, 'generated-queue');

const ARCHIVE_DIR =
  path.join(QUEUE_DIR, 'archive');

const REPLY_ARCHIVE_DIR =
  path.join(ARCHIVE_DIR, 'reply');

const INQUIRY_ARCHIVE_DIR =
  path.join(ARCHIVE_DIR, 'inquiry');

const REPLY_CURRENT_FILE =
  path.join(
    QUEUE_DIR,
    'current-reply.json'
  );

const INQUIRY_CURRENT_FILE =
  path.join(
    QUEUE_DIR,
    'current-inquiry.json'
  );

const NEXT_ID_FILE =
  path.join(
    QUEUE_DIR,
    'next-id.json'
  );

// 旧形式。初回移行用としてのみ使用
const LEGACY_CURRENT_FILE =
  path.join(
    QUEUE_DIR,
    'current.json'
  );


// ======================================================
// ディレクトリ
// ======================================================

function ensureDirs() {
  const dirs = [
    QUEUE_DIR,
    ARCHIVE_DIR,
    REPLY_ARCHIVE_DIR,
    INQUIRY_ARCHIVE_DIR
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(
        dir,
        { recursive: true }
      );
    }
  }
}


// ======================================================
// JST
// ======================================================

function getJstDate() {
  return new Date()
    .toLocaleDateString(
      'en-CA',
      {
        timeZone: 'Asia/Tokyo'
      }
    );
}


function getJstDatetime() {
  return new Date()
    .toLocaleString(
      'ja-JP',
      {
        timeZone: 'Asia/Tokyo'
      }
    );
}


// ======================================================
// queue type
// ======================================================

function getQueueTypeBySource(source) {
  if (
    String(source || '') ===
    'reply-skipped'
  ) {
    return 'reply';
  }

  if (
    String(source || '') ===
    'support' ||
    String(source || '') ===
    'contact'
  ) {
    return 'inquiry';
  }

  // 不明sourceは問い合わせ側へ逃がす
  return 'inquiry';
}


function getCurrentFile(queueType) {
  return queueType === 'reply'
    ? REPLY_CURRENT_FILE
    : INQUIRY_CURRENT_FILE;
}


function getArchiveDir(queueType) {
  return queueType === 'reply'
    ? REPLY_ARCHIVE_DIR
    : INQUIRY_ARCHIVE_DIR;
}


// ======================================================
// 空queue
// ======================================================

function createEmptyQueue() {
  return {
    date: getJstDate(),
    items: []
  };
}


// ======================================================
// atomic write
// ======================================================

function writeQueueFile(
  queueType,
  queue
) {
  ensureDirs();

  const currentFile =
    getCurrentFile(queueType);

  const tmpFile =
    `${currentFile}.tmp`;

  fs.writeFileSync(
    tmpFile,
    JSON.stringify(
      queue,
      null,
      2
    ),
    'utf8'
  );

  fs.renameSync(
    tmpFile,
    currentFile
  );
}


// ======================================================
// archive
// ======================================================

function archiveOldQueue(
  queueType,
  queue
) {
  if (
    !queue ||
    !queue.date
  ) {
    return;
  }

  const archiveDir =
    getArchiveDir(queueType);

  const archiveFile =
    path.join(
      archiveDir,
      `${queue.date}.json`
    );

  if (
    !fs.existsSync(
      archiveFile
    )
  ) {
    fs.writeFileSync(
      archiveFile,
      JSON.stringify(
        queue,
        null,
        2
      ),
      'utf8'
    );
  }
}


// ======================================================
// 旧current.json → 新2ファイルへ移行
// ======================================================

function migrateLegacyQueueIfNeeded() {
  ensureDirs();

  // 新形式が既に1つでも存在する場合は
  // 移行済みとして扱う
  if (
    fs.existsSync(REPLY_CURRENT_FILE) ||
    fs.existsSync(INQUIRY_CURRENT_FILE)
  ) {
    return;
  }

  if (
    !fs.existsSync(
      LEGACY_CURRENT_FILE
    )
  ) {
    return;
  }

  let legacy;

  try {
    legacy = JSON.parse(
      fs.readFileSync(
        LEGACY_CURRENT_FILE,
        'utf8'
      )
    );
  } catch (err) {
    console.error(
      '[GENERATED-QUEUE] ' +
      '旧current.json読込失敗:',
      err.message
    );

    return;
  }

  const replyQueue =
    createEmptyQueue();

  const inquiryQueue =
    createEmptyQueue();

  replyQueue.date =
    legacy.date ||
    getJstDate();

  inquiryQueue.date =
    legacy.date ||
    getJstDate();

  const items =
    Array.isArray(legacy.items)
      ? legacy.items
      : [];

  for (const item of items) {
    const queueType =
      getQueueTypeBySource(
        item.source
      );

    if (
      queueType === 'reply'
    ) {
      replyQueue.items.push(item);
    } else {
      inquiryQueue.items.push(item);
    }
  }

  writeQueueFile(
    'reply',
    replyQueue
  );

  writeQueueFile(
    'inquiry',
    inquiryQueue
  );

  console.log(
    `[GENERATED-QUEUE] ` +
    `旧current.jsonを分割移行 ` +
    `reply=${replyQueue.items.length}件 ` +
    `inquiry=${inquiryQueue.items.length}件`
  );

  // 旧ファイルは消さずに残す。
  // 誤移行時に確認できるようバックアップ扱い。
}


// ======================================================
// queue load
// ======================================================

function loadQueueFile(queueType) {
  ensureDirs();
  migrateLegacyQueueIfNeeded();

  const currentFile =
    getCurrentFile(queueType);

  if (
    !fs.existsSync(
      currentFile
    )
  ) {
    const queue =
      createEmptyQueue();

    writeQueueFile(
      queueType,
      queue
    );

    return queue;
  }

  let queue;

  try {
    queue = JSON.parse(
      fs.readFileSync(
        currentFile,
        'utf8'
      )
    );

  } catch (err) {
    console.error(
      `[GENERATED-QUEUE] ` +
      `${path.basename(currentFile)} 読込失敗:`,
      err.message
    );

    queue =
      createEmptyQueue();

    writeQueueFile(
      queueType,
      queue
    );

    return queue;
  }

  const today =
    getJstDate();

  if (
    queue.date !== today
  ) {
    console.log(
      `[GENERATED-QUEUE] ` +
      `${queueType} 日付変更 ` +
      `${queue.date} → ${today}`
    );

    archiveOldQueue(
      queueType,
      queue
    );

    queue =
      createEmptyQueue();

    writeQueueFile(
      queueType,
      queue
    );
  }

  if (
    !Array.isArray(
      queue.items
    )
  ) {
    queue.items = [];
  }

  return queue;
}


// ======================================================
// 後方互換用 loadQueue
//
// loadQueue('reply')
// loadQueue('inquiry')
// loadQueue() → 両方まとめて返す
// ======================================================

function loadQueue(queueType = null) {
  if (
    queueType === 'reply' ||
    queueType === 'inquiry'
  ) {
    return loadQueueFile(
      queueType
    );
  }

  const replyQueue =
    loadQueueFile('reply');

  const inquiryQueue =
    loadQueueFile('inquiry');

  return {
    date: getJstDate(),

    nextId:
      peekNextId(),

    items: [
      ...replyQueue.items,
      ...inquiryQueue.items
    ].sort(
      (a, b) =>
        Number(a.id) -
        Number(b.id)
    )
  };
}


// ======================================================
// 共通ID採番
// ======================================================

function calculateExistingMaxId() {
  const replyQueue =
    loadQueueFile('reply');

  const inquiryQueue =
    loadQueueFile('inquiry');

  return [
    ...replyQueue.items,
    ...inquiryQueue.items
  ].reduce(
    (max, item) =>
      Math.max(
        max,
        Number(item.id) || 0
      ),
    0
  );
}


function ensureNextIdFile() {
  ensureDirs();
  migrateLegacyQueueIfNeeded();

  if (
    fs.existsSync(
      NEXT_ID_FILE
    )
  ) {
    return;
  }

  const maxId =
    calculateExistingMaxId();

  fs.writeFileSync(
    NEXT_ID_FILE,
    JSON.stringify(
      {
        nextId: maxId + 1
      },
      null,
      2
    ),
    'utf8'
  );

  console.log(
    `[GENERATED-QUEUE] ` +
    `共通nextId初期化 → ${maxId + 1}`
  );
}


function peekNextId() {
  ensureNextIdFile();

  try {
    const data =
      JSON.parse(
        fs.readFileSync(
          NEXT_ID_FILE,
          'utf8'
        )
      );

    return Math.max(
      1,
      Number(data.nextId) || 1
    );

  } catch (_) {
    return (
      calculateExistingMaxId() +
      1
    );
  }
}


function takeNextId() {
  ensureNextIdFile();

  let current =
    peekNextId();

  const tmpFile =
    `${NEXT_ID_FILE}.tmp`;

  fs.writeFileSync(
    tmpFile,
    JSON.stringify(
      {
        nextId:
          current + 1
      },
      null,
      2
    ),
    'utf8'
  );

  fs.renameSync(
    tmpFile,
    NEXT_ID_FILE
  );

  return current;
}


// ======================================================
// sourceKey
// ======================================================

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


// ======================================================
// 同一返信対象判定
//
// reply-skipped:
//   source + uid + kid
//
// support:
//   source + uid + kid
//
// contact:
//   source + uid
// ======================================================

function isSameTarget(
  oldItem,
  newData
) {
  const oldSource =
    String(
      oldItem?.source || ''
    );

  const newSource =
    String(
      newData?.source || ''
    );

  if (
    oldSource !== newSource
  ) {
    return false;
  }

  const oldUid =
    String(
      oldItem?.uid || ''
    );

  const newUid =
    String(
      newData?.uid || ''
    );

  if (
    !oldUid ||
    !newUid ||
    oldUid !== newUid
  ) {
    return false;
  }

  // contactはuidだけで同一対象
  if (
    newSource === 'contact'
  ) {
    return true;
  }

  // reply / support は uid + kid
  const oldKid =
    String(
      oldItem?.kid || ''
    );

  const newKid =
    String(
      newData?.kid || ''
    );

  return (
    oldKid === newKid
  );
}


// ======================================================
// 古いpendingをsupersededへ
// ======================================================

function supersedeOlderPending(
  queue,
  data,
  newSourceKey
) {
  const supersededIds = [];

  for (
    const item of queue.items
  ) {
    if (
      item.status !== 'pending'
    ) {
      continue;
    }

    // 完全同一生成物はここでは触らない
    if (
      item.sourceKey ===
      newSourceKey
    ) {
      continue;
    }

    if (
      !isSameTarget(
        item,
        data
      )
    ) {
      continue;
    }

    item.status =
      'superseded';

    item.supersededAt =
      getJstDatetime();

    item.supersededReason =
      '同一対象から新しいメッセージを受信したため旧案化';

    supersededIds.push(
      item.id
    );
  }

  if (
    supersededIds.length > 0
  ) {
    console.log(
      `[GENERATED-QUEUE] ` +
      `旧案化 ids=${supersededIds.join(',')}`
    );
  }

  return supersededIds;
}


// ======================================================
// 生成登録
// ======================================================

function addGeneratedItem(data) {
  const queueType =
    getQueueTypeBySource(
      data.source
    );

  const queue =
    loadQueueFile(
      queueType
    );

  const sourceKey =
    data.sourceKey ||
    createSourceKey(data);


  // --------------------------------------------------
  // 完全一致は従来通り重複登録しない
  // --------------------------------------------------

  const existing =
    queue.items.find(
      item =>
        item.sourceKey ===
        sourceKey
    );

  if (existing) {
    console.log(
      `[GENERATED-QUEUE] ` +
      `重複のため追加しません ` +
      `id=${existing.id} ` +
      `status=${existing.status}`
    );

    return {
      created: false,
      item: existing
    };
  }


  // --------------------------------------------------
  // 同じ対象に古いpendingがあれば旧案化
  // --------------------------------------------------

  supersedeOlderPending(
    queue,
    data,
    sourceKey
  );


  // --------------------------------------------------
  // 新規登録
  // --------------------------------------------------

  const item = {
    id:
      takeNextId(),

    source:
      data.source ||
      'unknown',

    uid:
      data.uid != null
        ? String(data.uid)
        : '',

    kid:
      data.kid != null
        ? String(data.kid)
        : '',

    userName:
      data.userName || '',

    receivedAt:
      data.receivedAt || '',

    sourceKey,

    reason:
      data.reason || '',

    decision:
      data.decision || null,

    replyDraft:
      data.replyDraft ||
      data.generatedText ||
      '',

    commands:
      Array.isArray(
        data.commands
      )
        ? data.commands
        : [],

    userText:
      data.userText || '',

    action:
      data.action || '',

    generatedText:
      data.generatedText || '',

    comment:
      data.comment || '',

    finalText:
      data.finalText ||
      [
        data.generatedText || '',
        data.comment || ''
      ]
        .filter(Boolean)
        .join('\n'),

    status:
      'pending',

    generatedAt:
      getJstDatetime(),

    sentAt:
      null,

    skippedAt:
      null,

    supersededAt:
      null,

    supersededReason:
      null,

    errorAt:
      null,

    errorMessage:
      null
  };

  queue.items.push(item);

  writeQueueFile(
    queueType,
    queue
  );

  console.log(
    `[GENERATED-QUEUE] ` +
    `登録 id=${item.id} ` +
    `queue=${queueType} ` +
    `source=${item.source} ` +
    `uid=${item.uid} ` +
    `reason=${item.reason}`
  );

  return {
    created: true,
    item
  };
}


// ======================================================
// ID検索
// ======================================================

function findItemById(id) {
  const queueTypes = [
    'reply',
    'inquiry'
  ];

  for (
    const queueType
    of queueTypes
  ) {
    const queue =
      loadQueueFile(
        queueType
      );

    const item =
      queue.items.find(
        item =>
          Number(item.id) ===
          Number(id)
      );

    if (item) {
      return {
        queueType,
        queue,
        item
      };
    }
  }

  return null;
}


function getGeneratedItem(id) {
  const found =
    findItemById(id);

  return found
    ? found.item
    : null;
}


// ======================================================
// 一覧
// ======================================================

function listGeneratedItems({
  status = null,
  source = null,
  queueType = null
} = {}) {
  let items = [];

  if (
    queueType === 'reply' ||
    queueType === 'inquiry'
  ) {
    items = [
      ...loadQueueFile(
        queueType
      ).items
    ];

  } else {
    items = [
      ...loadQueueFile('reply').items,
      ...loadQueueFile('inquiry').items
    ];
  }

  return items
    .filter(item => {
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
    })
    .sort(
      (a, b) =>
        Number(a.id) -
        Number(b.id)
    );
}


// ======================================================
// status更新
// ======================================================

function updateItemStatus(
  id,
  status,
  extra = {}
) {
  const found =
    findItemById(id);

  if (!found) {
    return null;
  }

  const {
    queueType,
    queue,
    item
  } = found;

  item.status =
    status;

  Object.assign(
    item,
    extra
  );

  writeQueueFile(
    queueType,
    queue
  );

  console.log(
    `[GENERATED-QUEUE] ` +
    `status変更 ` +
    `id=${id} → ${status}`
  );

  return item;
}


function markGeneratedItemSent(id) {
  return updateItemStatus(
    id,
    'sent',
    {
      sentAt:
        getJstDatetime()
    }
  );
}


function markGeneratedItemSkipped(id) {
  return updateItemStatus(
    id,
    'skipped',
    {
      skippedAt:
        getJstDatetime()
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
      errorAt:
        getJstDatetime(),

      errorMessage:
        message != null
          ? String(message)
          : ''
    }
  );
}


// ======================================================
// 完全同一生成済み判定
// ======================================================

function isAlreadyGenerated(data) {
  const queueType =
    getQueueTypeBySource(
      data.source
    );

  const queue =
    loadQueueFile(
      queueType
    );

  const sourceKey =
    data.sourceKey ||
    createSourceKey(data);

  return queue.items.some(
    item =>
      item.sourceKey ===
      sourceKey
  );
}


// ======================================================
// export
// ======================================================

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
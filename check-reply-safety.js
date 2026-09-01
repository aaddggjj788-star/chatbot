const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { checkReplySafety } = require('./reply-safety');

const REPLY_CSV_DIR = path.join(__dirname, 'reply-csv');
const REPORT_PATH = path.join(__dirname, 'reply-safety-report.csv');
const IGNORE_PATH = path.join(__dirname, 'reply-safety-ignore.json');

// ======================================================
// 除外コメント読み込み
// ======================================================
function loadIgnoreComments() {
  if (!fs.existsSync(IGNORE_PATH)) {
    console.log('[INFO] reply-safety-ignore.json がありません。除外なしで実行します。');
    return new Set();
  }

  try {
    const config = JSON.parse(
      fs.readFileSync(IGNORE_PATH, 'utf8')
    );

    const list = Array.isArray(config.ignoreComments)
      ? config.ignoreComments
      : [];

    return new Set(
      list
        .map(v => String(v).trim())
        .filter(Boolean)
    );

  } catch (err) {
    console.error(
      `[ERROR] reply-safety-ignore.json の読み込みに失敗しました: ${err.message}`
    );

    process.exit(1);
  }
}

// ======================================================
// HTMLコメントアウト取得
//
// <!--12679yu3/sinko/79-->
// ↓
// 12679yu3/sinko/79
// ======================================================
function extractComments(text) {
  const comments = [];
  const source = String(text || '');

  const regex = /<!--\s*([\s\S]*?)\s*-->/g;

  let match;

  while ((match = regex.exec(source)) !== null) {
    const comment = String(match[1] || '').trim();

    if (comment) {
      comments.push(comment);
    }
  }

  return comments;
}

// ======================================================
// HTMLコメントを本文から除外
// ======================================================
function removeHtmlComments(text) {
  return String(text || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

// ======================================================
// 返信候補取得
//
// 対応形式:
//
// 形式1
// A列 = コメント
// B列 = 返信本文
//
// 形式2
// A列 = 返信本文 + コメント
// ======================================================
function extractReplyCandidates(record) {
  const candidates = [];

  if (!record || !record.length) {
    return candidates;
  }

  const colA = String(record[0] || '');
  const colB = String(record[1] || '');

  // --------------------------------------------------
  // B列に本文が存在する場合
  // A列 = コメント
  // B列 = 本文
  // として扱う
  // --------------------------------------------------
  if (colB.trim()) {
    const comments = [
      ...extractComments(colA),
      ...extractComments(colB)
    ];

    const replyText = removeHtmlComments(colB);

    if (replyText) {
      candidates.push({
        column: 'B列',
        text: replyText,
        comments
      });
    }

    return candidates;
  }

  // --------------------------------------------------
  // B列が空の場合
  // A列 = 本文 + コメント
  // として扱う
  // --------------------------------------------------
  if (colA.trim()) {
    const comments = extractComments(colA);
    const replyText = removeHtmlComments(colA);

    if (replyText) {
      candidates.push({
        column: 'A列',
        text: replyText,
        comments
      });
    }
  }

  return candidates;
}

// ======================================================
// 除外登録確認
// ======================================================
function findIgnoredComment(comments, ignoreComments) {
  for (const comment of comments) {
    if (ignoreComments.has(comment)) {
      return comment;
    }
  }

  return null;
}

// ======================================================
// CSV出力用
// ======================================================
function csvEscape(value) {
  const text = String(value ?? '');

  return `"${text.replace(/"/g, '""')}"`;
}

// ======================================================
// メイン
// ======================================================
function main() {
  if (!fs.existsSync(REPLY_CSV_DIR)) {
    console.error(
      `reply-csv フォルダが見つかりません: ${REPLY_CSV_DIR}`
    );

    process.exit(1);
  }

  const ignoreComments = loadIgnoreComments();

  const files = fs
    .readdirSync(REPLY_CSV_DIR)
    .filter(name => name.toLowerCase().endsWith('.csv'))
    .sort();

  let totalRows = 0;
  let totalCandidates = 0;
  let totalDanger = 0;
  let totalIgnore = 0;
  let totalReadErrors = 0;

  const reportRows = [
    [
      '判定',
      'ファイル名',
      'CSV行',
      '本文列',
      'コメントアウト',
      '危険理由',
      '文頭3有効行',
      '文末3有効行'
    ]
  ];

  console.log('');
  console.log('========================================');
  console.log('返信CSV安全チェック');
  console.log('========================================');
  console.log(`安全チェック除外登録: ${ignoreComments.size}件`);

  // ====================================================
  // CSVファイル走査
  // ====================================================
  for (const fileName of files) {
    const filePath = path.join(REPLY_CSV_DIR, fileName);

    let records;

    try {
      const raw = fs.readFileSync(filePath, 'utf8');

      records = parse(raw, {
        bom: true,
        skip_empty_lines: false,
        relax_quotes: true,
        relax_column_count: true,
        record_delimiter: ['\r\n', '\n', '\r']
      });

    } catch (err) {
      totalReadErrors++;

      console.log('');
      console.log(`[CSV読込エラー] ${fileName}`);
      console.log(`  ${err.message}`);

      continue;
    }

    // ==================================================
    // CSV行走査
    // ==================================================
    for (let i = 0; i < records.length; i++) {
      const record = records[i];

      totalRows++;

      const candidates = extractReplyCandidates(record);

      for (const candidate of candidates) {
        totalCandidates++;

        const result = checkReplySafety(candidate.text);

        // 安全なら何もしない
        if (result.safe) {
          continue;
        }

        const csvLine = i + 1;

        // ------------------------------------------------
        // 除外コメント確認
        // ------------------------------------------------
        const ignoredComment = findIgnoredComment(
          candidate.comments,
          ignoreComments
        );

        // =================================================
        // IGNORE
        // =================================================
        if (ignoredComment) {
          totalIgnore++;

          console.log('');
          console.log(
            `[IGNORE] ${fileName}  CSV行:${csvLine}  ${candidate.column}`
          );

          console.log(
            `  コメント: ${ignoredComment}`
          );

          for (const reason of result.reasons) {
            console.log(`  ・${reason}`);
          }

          reportRows.push([
            'IGNORE',
            fileName,
            csvLine,
            candidate.column,
            ignoredComment,
            result.reasons.join(' / '),
            result.headLines.join(' / '),
            result.tailLines.join(' / ')
          ]);

          continue;
        }

        // =================================================
        // NG
        // =================================================
        totalDanger++;

        console.log('');
        console.log(
          `[NG] ${fileName}  CSV行:${csvLine}  ${candidate.column}`
        );

        if (candidate.comments.length) {
          console.log(
            `  コメント: ${candidate.comments.join(' / ')}`
          );
        } else {
          console.log('  コメント: なし');
        }

        for (const reason of result.reasons) {
          console.log(`  ・${reason}`);
        }

        console.log(
          `  文頭: ${result.headLines.join(' / ')}`
        );

        console.log(
          `  文末: ${result.tailLines.join(' / ')}`
        );

        reportRows.push([
          'NG',
          fileName,
          csvLine,
          candidate.column,
          candidate.comments.join(' / '),
          result.reasons.join(' / '),
          result.headLines.join(' / '),
          result.tailLines.join(' / ')
        ]);
      }
    }
  }

  // ====================================================
  // レポート保存
  // ====================================================
  const reportText =
    '\uFEFF' +
    reportRows
      .map(row => row.map(csvEscape).join(','))
      .join('\r\n');

  fs.writeFileSync(
    REPORT_PATH,
    reportText,
    'utf8'
  );

  console.log('');
  console.log('========================================');
  console.log('チェック完了');
  console.log('========================================');

  console.log(`CSVファイル数 : ${files.length}`);
  console.log(`CSV総行数     : ${totalRows}`);
  console.log(`返信候補数    : ${totalCandidates}`);
  console.log(`危険文章 NG   : ${totalDanger}`);
  console.log(`除外 IGNORE   : ${totalIgnore}`);
  console.log(`CSV読込エラー : ${totalReadErrors}`);

  console.log('');
  console.log(`レポート: ${REPORT_PATH}`);
  console.log('');
}

main();
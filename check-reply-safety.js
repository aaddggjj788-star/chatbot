const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { checkReplySafety } = require('./reply-safety');

const REPLY_CSV_DIR = path.join(__dirname, 'reply-csv');
const REPORT_PATH = path.join(__dirname, 'reply-safety-report.csv');

function extractReplyCandidates(record) {
  const candidates = [];

  if (!record || !record.length) {
    return candidates;
  }

  // --------------------------------------------------
  // 形式1
  // A列 = コメント
  // B列 = 返信本文
  // --------------------------------------------------
  if (record.length >= 2 && String(record[1] || '').trim()) {
    candidates.push({
      column: 'B列',
      text: String(record[1] || '')
    });
  }

  // --------------------------------------------------
  // 形式2
  // A列 = 返信本文 + HTMLコメント
  //
  // HTMLコメント自体は画面に表示されないため、
  // 安全チェック対象から除外する
  // --------------------------------------------------
  const colA = String(record[0] || '').trim();

  if (colA) {
    const withoutComments = colA
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();

    if (withoutComments) {
      candidates.push({
        column: 'A列',
        text: withoutComments
      });
    }
  }

  return candidates;
}

function csvEscape(value) {
  const text = String(value ?? '');

  return `"${text.replace(/"/g, '""')}"`;
}

function main() {
  // --------------------------------------------------
  // reply-csv確認
  // --------------------------------------------------
  if (!fs.existsSync(REPLY_CSV_DIR)) {
    console.error(
      `reply-csv フォルダが見つかりません: ${REPLY_CSV_DIR}`
    );

    process.exit(1);
  }

  // --------------------------------------------------
  // CSV一覧取得
  // --------------------------------------------------
  const files = fs
    .readdirSync(REPLY_CSV_DIR)
    .filter(name => name.toLowerCase().endsWith('.csv'))
    .sort();

  let totalRows = 0;
  let totalCandidates = 0;
  let totalDanger = 0;
  let totalReadErrors = 0;

  // --------------------------------------------------
  // 出力レポート
  // --------------------------------------------------
  const reportRows = [
    [
      'ファイル名',
      'CSV行',
      '本文列',
      '危険理由',
      '文頭3有効行',
      '文末3有効行'
    ]
  ];

  console.log('');
  console.log('========================================');
  console.log('返信CSV安全チェック');
  console.log('========================================');

  // --------------------------------------------------
  // 全CSV走査
  // --------------------------------------------------
  for (const fileName of files) {
    const filePath = path.join(REPLY_CSV_DIR, fileName);

    let records;

    try {
      const raw = fs.readFileSync(filePath, 'utf8');

      // reply-checker側に合わせて
      // csv-parseを使用
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

    // --------------------------------------------------
    // CSV各行
    // --------------------------------------------------
    for (let i = 0; i < records.length; i++) {
      const record = records[i];

      totalRows++;

      const candidates = extractReplyCandidates(record);

      for (const candidate of candidates) {
        totalCandidates++;

        // reply-safety.jsの共通判定を使用
        const result = checkReplySafety(candidate.text);

        if (result.safe) {
          continue;
        }

        totalDanger++;

        const csvLine = i + 1;

        console.log('');
        console.log(
          `[NG] ${fileName}  CSV行:${csvLine}  ${candidate.column}`
        );

        for (const reason of result.reasons) {
          console.log(`  ・${reason}`);
        }

        console.log('');
        console.log(
          `  文頭: ${result.headLines.join(' / ')}`
        );

        console.log(
          `  文末: ${result.tailLines.join(' / ')}`
        );

        reportRows.push([
          fileName,
          csvLine,
          candidate.column,
          result.reasons.join(' / '),
          result.headLines.join(' / '),
          result.tailLines.join(' / ')
        ]);
      }
    }
  }

  // --------------------------------------------------
  // CSVレポート出力
  // --------------------------------------------------
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

  // --------------------------------------------------
  // 集計
  // --------------------------------------------------
  console.log('');
  console.log('========================================');
  console.log('チェック完了');
  console.log('========================================');

  console.log(`CSVファイル数 : ${files.length}`);
  console.log(`CSV総行数     : ${totalRows}`);
  console.log(`返信候補数    : ${totalCandidates}`);
  console.log(`危険文章      : ${totalDanger}`);
  console.log(`CSV読込エラー : ${totalReadErrors}`);

  console.log('');
  console.log(`レポート: ${REPORT_PATH}`);
  console.log('');
}

main();
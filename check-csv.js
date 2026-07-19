'use strict';

/**
 * check-csv.js
 * reply-checker.js のCSV検索ロジックを単体で確認するためのデバッグ用スクリプト
 *
 * 実行:
 *   node check-csv.js {charaId} {commentTarget}
 *
 * 例:
 *   node check-csv.js 12668yu6 "12668yu6/sinko/153"
 *     → CSVから該当コメントアウトを検索して次行の内容を表示
 *   node check-csv.js 12668yu6 ho
 *     → 履歴検索なしでsinko/1から順に内容を表示
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const fs = require('fs');
const path = require('path');
const { parse: parseCSVSync } = require('csv-parse/sync');

const CSV_DIR = process.env.REPLY_CSV_DIR || path.join(__dirname, 'reply-csv');

// reply-checker.js の parseCSV と同じ設定
function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return parseCSVSync(content, {
    relax_quotes:        true,
    relax_column_count:  true,
    skip_empty_lines:    false,
    quote:               '"',
    escape:              '"',
  });
}

// reply-checker.js の resolveCsvPath と同じロジック（fileId指定なしの簡易版）
function resolveCsvPath(charaId) {
  let files;
  try { files = fs.readdirSync(CSV_DIR); } catch (_) { files = []; }

  function findByPrefix(prefix) {
    const candidates = files.filter(f => f.startsWith(prefix) && f.endsWith('.csv'));
    if (candidates.length === 0) return null;
    return candidates.find(f => f.includes('sinko')) || candidates[0];
  }

  const exactMatch = findByPrefix(charaId);
  if (exactMatch) {
    return { csvPath: path.join(CSV_DIR, exactMatch), resolvedCharaId: charaId };
  }

  const m = charaId.match(/^(\d+)(yu|mu)(\d+)$/);
  if (m) {
    const [, baseId, type, numStr] = m;
    const targetNum = parseInt(numStr, 10);
    let bestNum = -1;
    let bestFile = null;
    for (const f of files) {
      if (!f.endsWith('.csv')) continue;
      const fm = f.match(new RegExp(`^${baseId}${type}(\\d+)`));
      if (!fm) continue;
      const n = parseInt(fm[1], 10);
      if (n <= targetNum && n > bestNum) { bestNum = n; bestFile = f; }
    }
    if (bestFile) {
      const resolvedCharaId = `${baseId}${type}${bestNum}`;
      return { csvPath: path.join(CSV_DIR, bestFile), resolvedCharaId };
    }
  }

  return { csvPath: path.join(CSV_DIR, charaId + '.csv'), resolvedCharaId: charaId };
}

// reply-checker.js の splitAColumn と同じロジック
function splitAColumn(aContent) {
  const s = (aContent || '').trim();
  const commentStart = s.lastIndexOf('<!--');
  if (commentStart >= 0) {
    return {
      replyText: s.slice(0, commentStart).trim().replace(/\\n/g, '\n').trim(),
      nextComment: s.slice(commentStart),
    };
  }
  return {
    replyText: s.replace(/\\n/g, '\n').trim(),
    nextComment: '',
  };
}

function printResult(csvPath, rowIdx, row) {
  const { replyText, nextComment } = splitAColumn(row[0]);
  console.log(`CSVファイル: ${csvPath}`);
  console.log(`マッチした行番号: ${rowIdx}`);
  console.log('--- 返信文章 ---');
  console.log(replyText);
  console.log('--- nextComment ---');
  console.log(nextComment);
}

// commentTarget指定モード: 該当コメントアウトを検索して次行の内容を表示する
function searchByTarget(charaId, commentTarget) {
  const { csvPath } = resolveCsvPath(charaId);
  if (!fs.existsSync(csvPath)) {
    console.error(`CSVなし: ${csvPath}`);
    process.exit(1);
  }
  const rows = parseCSV(csvPath);
  console.log(`CSVファイル: ${csvPath}`);
  console.log(`総行数: ${rows.length}`);

  // reply-checker.js の getReplyFromCSVByTarget と同じマッチング（his/2 ↔ his2 の省略形も許容）
  const escaped = commentTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flexEscaped = escaped.replace(/\/(\d)/g, '\\/?$1');
  const pattern = new RegExp(`<!--${flexEscaped}-->`);
  console.log(`検索パターン: ${pattern}`);

  const idx = rows.findIndex(r => pattern.test((r[0] || '').trim()));
  if (idx === -1) {
    const sample = rows.slice(0, 10).map((r, i) => `  row[${i}]: "${(r[0] || '').trim().slice(0, 60)}"`).join('\n');
    console.error(`commentTarget "${commentTarget}" がCSVに未発見\nCSV先頭10行:\n${sample}`);
    process.exit(1);
  }
  console.log(`マッチ: row[${idx}] A="${(rows[idx][0] || '').trim().slice(0, 60)}"`);

  const nextIdx = idx + 1;
  const nextRow = rows[nextIdx];
  if (!nextRow) {
    console.error(`マッチ行(row[${idx}])の次行が存在しません（末尾到達）`);
    process.exit(1);
  }

  printResult(csvPath, nextIdx, nextRow);
}

// "ho"指定モード: 履歴検索を行わず、CSV内のsinko/hisコメントを先頭から順に走査し
// それぞれの次行（返信文章・nextComment）を表示する
function searchHoSequential(charaId) {
  const { csvPath } = resolveCsvPath(charaId);
  if (!fs.existsSync(csvPath)) {
    console.error(`CSVなし: ${csvPath}`);
    process.exit(1);
  }
  const rows = parseCSV(csvPath);
  console.log(`CSVファイル: ${csvPath}`);
  console.log(`総行数: ${rows.length}`);

  const commentRe = /<!--([^>]+)-->/;
  let found = 0;
  for (let i = 0; i < rows.length; i++) {
    const cm = commentRe.exec((rows[i][0] || '').trim());
    if (!cm) continue;
    const commentStr = cm[1];
    const numM = commentStr.match(/(?:sinko|his\w*)\/?(\d+)/);
    if (!numM) continue;
    found++;

    const nextIdx = i + 1;
    const nextRow = rows[nextIdx];
    console.log(`\n=== sinko/his ${numM[1]} (row[${i}], comment="${commentStr}") ===`);
    if (!nextRow) {
      console.log('マッチした行番号: (次行なし・末尾到達)');
      continue;
    }
    printResult(csvPath, nextIdx, nextRow);
  }
  if (found === 0) console.log('sinko/hisコメントが見つかりませんでした');
}

function main() {
  const [, , charaId, commentTarget] = process.argv;
  if (!charaId || !commentTarget) {
    console.error('使い方: node check-csv.js {charaId} {commentTarget}');
    console.error('例:     node check-csv.js 12668yu6 "12668yu6/sinko/153"');
    console.error('例:     node check-csv.js 12668yu6 ho');
    process.exit(1);
  }

  if (commentTarget === 'ho') {
    searchHoSequential(charaId);
  } else {
    searchByTarget(charaId, commentTarget);
  }
}

main();

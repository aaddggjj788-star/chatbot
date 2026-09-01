'use strict';

/**
 * check-csv-batch.js
 * 複数のコメントアウトをまとめて check-csv.js と同じチェックにかけるツール。
 * 各コメントに対して check-csv.js の --chara/--comment モード（runJsonMode）を
 * 実行し、結果を一覧で表示する。
 *
 * 実行:
 *   node check-csv-batch.js --chara {charaId} --comments "{comment1,comment2,...}"
 *     例: node check-csv-batch.js --chara 12687 --comments "12687yu3mu/ho,12687yu4/ho,12687yu5/ho"
 *
 *   node check-csv-batch.js --chara {charaId} --file {comments.txt}
 *     例: node check-csv-batch.js --chara 12687 --file comments.txt
 *     ※ comments.txt は1行1コメント。空行と # から始まる行（コメント）は無視する。
 *
 * ※ charaId は chara-config/{charaId}.json を参照するためのIDを指定する
 *   （check-csv.js の --chara と同じ。例: 12687）。
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const fs = require('fs');
const path = require('path');
const { runJsonMode } = require('./check-csv');

// ─── 引数パース ───────────────────────────────────────────────────
function getFlagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}

// カンマ区切り文字列 or テキストファイルからコメント一覧を組み立てる
function collectComments({ commentsArg, fileArg }) {
  const comments = [];

  if (commentsArg) {
    for (const c of commentsArg.split(',')) {
      const t = c.trim();
      if (t) comments.push(t);
    }
  }

  if (fileArg) {
    const filePath = path.isAbsolute(fileArg) ? fileArg : path.join(process.cwd(), fileArg);
    if (!fs.existsSync(filePath)) {
      console.error(`ファイルが見つかりません: ${filePath}`);
      process.exit(1);
    }
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue; // 空行・# コメント行は無視
      comments.push(t);
    }
  }

  return comments;
}

function usageAndExit() {
  console.error('使い方:');
  console.error('  node check-csv-batch.js --chara {charaId} --comments "{comment1,comment2,...}"');
  console.error('  node check-csv-batch.js --chara {charaId} --file {comments.txt}');
  console.error('例:');
  console.error('  node check-csv-batch.js --chara 12687 --comments "12687yu3mu/ho,12687yu4/ho,12687yu5/ho"');
  console.error('  node check-csv-batch.js --chara 12687 --file comments.txt');
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const charaId     = getFlagValue(args, '--chara');
  const commentsArg = getFlagValue(args, '--comments');
  const fileArg     = getFlagValue(args, '--file');

  if (!charaId || (!commentsArg && !fileArg)) {
    usageAndExit();
  }

  const comments = collectComments({ commentsArg, fileArg });
  if (comments.length === 0) {
    console.error('チェック対象のコメントが1件もありません（--comments / --file の内容を確認してください）');
    process.exit(1);
  }

  console.log(`対象chara: ${charaId}`);
  console.log(`チェック件数: ${comments.length}件`);

  let okCount = 0;
  let ngCount = 0;

  for (const comment of comments) {
    console.log(`\n=== ${comment} ===`);
    try {
      runJsonMode(charaId, comment);
      okCount++;
    } catch (e) {
      // 1件が失敗しても残りのコメントのチェックは続行する
      console.error(`【エラー】${e.message}`);
      ngCount++;
    }
  }

  console.log(`\n=== 集計 ===`);
  console.log(`成功: ${okCount}件 / エラー: ${ngCount}件 / 合計: ${comments.length}件`);
}

main();

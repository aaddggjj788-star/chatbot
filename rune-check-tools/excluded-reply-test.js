'use strict';

const readline = require('readline');
const { testExcludedReply } = require('./reply-checker');

if (typeof testExcludedReply !== 'function') {
  console.error('\n[ERROR] reply-checker.js に testExcludedReply がexportされていません。\n');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = label => new Promise(r => rl.question(label, v => r(v.trim())));

async function readMultiline(label) {
  console.log(label);
  console.log('※ 入力終了は空行を2回 Enter');
  const lines = [];
  let empty = 0;
  while (true) {
    const line = await ask('');
    if (line === '') {
      empty++;
      if (empty >= 2) break;
      lines.push('');
    } else {
      empty = 0;
      lines.push(line);
    }
  }
  return lines.join('\n').trim();
}

const splitWords = text =>
  String(text || '').split(/[,、]/).map(v => v.trim()).filter(Boolean);

(async () => {
  console.log('\n=== 対象外返信 AI生成テスト ===\n');
  const kid = await ask('KID: ');
  const latestComment = await ask('最新コメント: ');
  const expectedRaw = await ask('期待返信ワード（複数はカンマ区切り）: ');
  const unmatchedRaw = await ask('不一致ワード（複数はカンマ区切り）: ');
  const kanteishiText = await readMultiline('\n【直前の鑑定士メッセージ】');
  const userText = await readMultiline('\n【ユーザー返信】');

  const result = await testExcludedReply({
    kid,
    latestComment,
    kanteishiText,
    userText,
    expectedReplyWords: splitWords(expectedRaw),
    unmatchedWords: splitWords(unmatchedRaw)
  });

  console.log('\n=== AI判定 ===');
  console.log(JSON.stringify(result.decision, null, 2));

  console.log('\n=== 生成結果 ===');
  console.log(result.replyDraft || '（生成なし / skip判定）');

  console.log('\n=== 想定アクション ===');
  console.log(result.action || '不明');

  if (Array.isArray(result.commands) && result.commands.length) {
    console.log('\n=== 本番時の想定コマンド ===');
    for (const cmd of result.commands) console.log(`・${cmd}`);
  }
})()
  .catch(err => {
    console.error('\n[ERROR]', err.message);
    process.exitCode = 1;
  })
  .finally(() => rl.close());

'use strict';

const readline = require('readline');
const { testSpecialProcess } = require('./reply-checker');

if (typeof testSpecialProcess !== 'function') {
  console.error('\n[ERROR] reply-checker.js に testSpecialProcess がexportされていません。\n');
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

(async () => {
  console.log('\n=== specialProcess テスト ===\n');
  console.log('1: saveNickname');
  console.log('2: saveMemo1\n');

  const selected = await ask('番号: ');
  const processName =
    selected === '1' ? 'saveNickname' :
    selected === '2' ? 'saveMemo1' :
    selected;

  const userText = await readMultiline('\n【ユーザー返信】');
  const result = await testSpecialProcess(processName, userText);

  console.log('\n=== 判定結果 ===');
  console.log(JSON.stringify(result, null, 2));

  if (processName === 'saveNickname') {
    console.log('\n=== ニックネーム取得 ===');
    console.log(result.nickname ? `取得成功: ${result.nickname}` : '取得できませんでした');
  }

  if (processName === 'saveMemo1') {
    console.log('\n=== memo1へ保存される内容 ===');
    console.log(result.memoText || '（空）');
  }

  console.log('\n※ テストのため実際の会員情報は変更しません。\n');
})()
  .catch(err => {
    console.error('\n[ERROR]', err.message);
    process.exitCode = 1;
  })
  .finally(() => rl.close());

'use strict';

const readline = require('readline');

const {
  testSpecialProcess
} = require('./reply-checker');

if (
  typeof testSpecialProcess !== 'function'
) {
  console.error(
    '\n[ERROR] reply-checker.js に ' +
    'testSpecialProcess がexportされていません。\n'
  );

  process.exit(1);
}


const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});


function ask(label) {
  return new Promise(resolve => {
    rl.question(
      label,
      answer =>
        resolve(
          String(answer || '').trim()
        )
    );
  });
}


async function readMultiline() {
  console.log(
    '\n【ユーザー返信】'
  );

  console.log(
    '※ 空行を2回で判定実行'
  );

  console.log(
    '※ /reset でprocess選択へ戻る'
  );

  console.log(
    '※ /exit で終了\n'
  );


  const lines = [];
  let emptyCount = 0;


  while (true) {
    const line =
      await ask('');


    // 終了
    if (
      line === '/exit'
    ) {
      return {
        command: 'exit'
      };
    }


    // process選択へ戻る
    if (
      line === '/reset'
    ) {
      return {
        command: 'reset'
      };
    }


    if (
      line === ''
    ) {
      emptyCount++;

      if (
        emptyCount >= 2
      ) {
        break;
      }

      lines.push('');

      continue;
    }


    emptyCount = 0;
    lines.push(line);
  }


  return {
    command: 'test',

    text:
      lines
        .join('\n')
        .trim()
  };
}


async function selectProcess() {
  while (true) {
    console.log(
      '\n=== specialProcess 選択 ===\n'
    );

    console.log(
      '1: saveNickname'
    );

    console.log(
      '2: saveMemo1'
    );

    console.log(
      '/exit: 終了\n'
    );


    const selected =
      await ask('番号: ');


    if (
      selected === '/exit'
    ) {
      return null;
    }


    if (
      selected === '1'
    ) {
      return 'saveNickname';
    }


    if (
      selected === '2'
    ) {
      return 'saveMemo1';
    }


    // 名前を直接入力してもOK
    if (
      selected === 'saveNickname' ||
      selected === 'saveMemo1'
    ) {
      return selected;
    }


    console.log(
      '\n[WARN] 1 または 2 を入力してください。'
    );
  }
}


async function runTest(
  processName,
  userText
) {
  const result =
    await testSpecialProcess(
      processName,
      userText
    );


  console.log(
    '\n=============================='
  );

  console.log(
    '=== 判定結果 ==='
  );

  console.log(
    '==============================\n'
  );


  console.log(
    JSON.stringify(
      result,
      null,
      2
    )
  );


  if (
    processName ===
    'saveNickname'
  ) {
    console.log(
      '\n=== ニックネーム取得 ==='
    );

    console.log(
      result.nickname
        ? `取得成功: ${result.nickname}`
        : '取得できませんでした'
    );
  }


  if (
    processName ===
    'saveMemo1'
  ) {
    console.log(
      '\n=== memo1へ保存される内容 ==='
    );

    console.log(
      result.memoText ||
      '（空）'
    );
  }


  console.log(
    '\n※ テストのため実際の会員情報は変更しません。'
  );
}


async function main() {
  console.log(
    '\n=== specialProcess テスト ==='
  );


  while (true) {
    const processName =
      await selectProcess();


    if (
      !processName
    ) {
      break;
    }


    console.log(
      `\n現在のprocess: ${processName}`
    );


    // 同じprocessを何度でも試せる
    while (true) {
      const input =
        await readMultiline();


      if (
        input.command === 'exit'
      ) {
        return;
      }


      if (
        input.command === 'reset'
      ) {
        break;
      }


      if (
        !input.text
      ) {
        console.log(
          '\n[WARN] 入力内容が空です。'
        );

        continue;
      }


      try {
        await runTest(
          processName,
          input.text
        );

      } catch (err) {
        console.error(
          '\n[ERROR]',
          err.message
        );
      }


      console.log(
        '\n--------------------------------'
      );

      console.log(
        `同じ ${processName} を続けてテストできます。`
      );

      console.log(
        '/reset でprocess変更、/exit で終了'
      );
    }
  }
}


main()
  .catch(err => {
    console.error(
      '\n[ERROR]',
      err.message
    );

    process.exitCode = 1;
  })
  .finally(() => {
    rl.close();
  });
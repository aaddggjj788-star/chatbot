'use strict';

const readline =
  require('readline');

const {
  testStructuredReply
} = require('./reply-checker');


const rl =
  readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });


function ask(question) {
  return new Promise(resolve => {
    rl.question(
      question,
      answer => resolve(answer)
    );
  });
}


// ======================================================
// 複数行入力
//
// 空行が2回続いたら入力終了
//
// /reset → コメントアウト選択へ戻る
// /exit  → テスト終了
// ======================================================

function askMultiline() {
  return new Promise(resolve => {
    console.log('');
    console.log('ユーザー返信 >');
    console.log(
      '※入力終了は空Enterを2回 / コメント変更は /reset / 終了は /exit'
    );
    console.log('');

    const lines = [];

    let emptyCount = 0;


    const onLine = line => {
      const raw =
        String(line ?? '');

      const trimmed =
        raw.trim();


      // ----------------------------------------------
      // 特殊コマンド
      // ----------------------------------------------

      if (
        lines.length === 0 &&
        trimmed === '/reset'
      ) {
        rl.removeListener(
          'line',
          onLine
        );

        resolve({
          command: 'reset',
          text: ''
        });

        return;
      }


      if (
        lines.length === 0 &&
        trimmed === '/exit'
      ) {
        rl.removeListener(
          'line',
          onLine
        );

        resolve({
          command: 'exit',
          text: ''
        });

        return;
      }


      // ----------------------------------------------
      // 空行
      // ----------------------------------------------

      if (trimmed === '') {
        emptyCount++;

        // 空Enterが2回続いたら確定
        if (emptyCount >= 2) {
          rl.removeListener(
            'line',
            onLine
          );

          // 最後の空行は本文には入れない
          resolve({
            command: 'submit',
            text:
              lines.join('\n').trim()
          });

          return;
        }

        // 1回目の空行は、
        // 本文中の改行として保持
        lines.push('');

        return;
      }


      // 通常文字が来たら
      // 空行カウントをリセット
      emptyCount = 0;

      lines.push(raw);
    };


    rl.on(
      'line',
      onLine
    );
  });
}


// ======================================================
// 判定結果表示
// ======================================================

function printResult(result) {
  console.log('');
  console.log(
    '========== MACHINE =========='
  );


  if (result.machine) {
    console.log(
      `status : ${result.machine.status}`
    );

    console.log(
      `type   : ${result.machine.type || '-'}`
    );

    console.log(
      `reason : ${result.machine.reason || '-'}`
    );
  } else {
    console.log(
      'structuredルールなし'
    );
  }


  console.log('');
  console.log(
    '========== FALLBACK ========='
  );


  if (result.fallback) {
    console.log(
      `category : ${result.fallback.category}`
    );

    console.log(
      `reason   : ${result.fallback.reason || '-'}`
    );
  } else {
    console.log(
      'fallback AI 未使用'
    );
  }


  console.log('');
  console.log(
    '=========== FINAL ==========='
  );

  console.log(
    `result : ${result.finalStatus}`
  );


  if (result.template) {
    console.log('');
    console.log(
      '------- 返信テンプレート -------'
    );

    console.log(
      result.template
    );

    console.log(
      '-------------------------------'
    );
  }

  console.log('');
}


// ======================================================
// メイン
// ======================================================

async function main() {
  console.log('');
  console.log(
    '======================================'
  );
  console.log(
    ' structured質問 判定テスト'
  );
  console.log(
    '======================================'
  );

  console.log('');
  console.log(
    '/reset : コメントアウト変更'
  );
  console.log(
    '/exit  : 終了'
  );
  console.log('');


  let currentComment = '';


  while (true) {

    // ==================================================
    // コメントアウト未選択時だけ入力
    // ==================================================

    if (!currentComment) {
      const comment =
        (
          await ask(
            'コメントアウト > '
          )
        ).trim();


      if (
        comment === '/exit'
      ) {
        break;
      }


      if (!comment) {
        console.log(
          'コメントアウトを入力してください。'
        );

        continue;
      }


      currentComment =
        comment;


      console.log('');
      console.log(
        `[固定コメントアウト] ${currentComment}`
      );
    }


    // ==================================================
    // ユーザー返信入力
    // ==================================================

    const input =
      await askMultiline();


    // コメント変更
    if (
      input.command === 'reset'
    ) {
      currentComment = '';

      console.log('');
      console.log(
        'コメントアウトをリセットしました。'
      );
      console.log('');

      continue;
    }


    // 終了
    if (
      input.command === 'exit'
    ) {
      break;
    }


    const text =
      String(input.text || '')
        .trim();


    if (!text) {
      console.log(
        'ユーザー返信が空です。'
      );

      continue;
    }


    console.log('');
    console.log(
      `対象コメントアウト: ${currentComment}`
    );

    console.log('');
    console.log(
      '判定中...'
    );


    try {
      const result =
        await testStructuredReply(
          currentComment,
          [text]
        );

      printResult(result);

    } catch (err) {
      console.error(
        '[TEST ERROR]',
        err.message
      );

      console.log('');
    }


    console.log(
      '--------------------------------------'
    );

    console.log(
      `固定中: ${currentComment}`
    );

    console.log(
      '次のユーザー返信を入力してください。'
    );

    console.log(
      'コメント変更は /reset、終了は /exit'
    );
  }


  rl.close();

  console.log('');
  console.log(
    'テストを終了しました。'
  );
}


main().catch(err => {
  console.error(err);
  process.exit(1);
});
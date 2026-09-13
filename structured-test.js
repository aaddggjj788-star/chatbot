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


async function main() {
  console.log('');
  console.log('======================================');
  console.log(' structured質問 判定テスト');
  console.log('======================================');
  console.log('');
  console.log('終了する場合は exit と入力');
  console.log('');


  while (true) {
    const comment =
      (
        await ask(
          'コメントアウト > '
        )
      ).trim();


    if (
      comment.toLowerCase() === 'exit'
    ) {
      break;
    }


    if (!comment) {
      console.log(
        'コメントアウトを入力してください。\n'
      );

      continue;
    }


    const text =
      await ask(
        'ユーザー返信   > '
      );


    if (
      text.trim().toLowerCase() === 'exit'
    ) {
      break;
    }


    console.log('');
    console.log('判定中...');
    console.log('');


    try {
      const result =
        await testStructuredReply(
          comment,
          [text]
        );


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


    } catch (err) {
      console.error(
        '[TEST ERROR]',
        err.message
      );
    }


    console.log('');
    console.log(
      '======================================'
    );
    console.log('');
  }


  rl.close();

  console.log(
    '\nテストを終了しました。'
  );
}


main().catch(err => {
  console.error(err);
  process.exit(1);
});
RUNE VPS チェックツール

配置先:
/root/rune-bot/

実行:
node excluded-reply-test.js
node specialprocess-test.js

excluded-reply-test.js:
対象外返信のAI分類と返信生成結果を確認します。
送信・生成キュー保存は行いません。

specialprocess-test.js:
saveNickname / saveMemo1 の抽出判定を確認します。
実際の会員情報は変更しません。

重要:
対象外テスト用の生成プロンプトはテスト側へコピーせず、
本番の generationInstruction 分岐を共通関数へ切り出して再利用してください。

# Discord Event Poster

GitHub Pagesで動作する、複数イベントのDiscordフォーラム投稿ツールです。

## 使い方

1. DiscordフォーラムのWebhook URLを入力する。
2. Xなどからコピーした告知文を貼り付けて「解析する」を押す。
3. 抽出結果を編集し、投稿対象を選ぶ。
4. 投稿内容を確認してからDiscordへ投稿する。

Webhook URLはユーザーが選択した場合だけ、この端末のlocalStorageに保存します。localStorageは暗号化された秘密情報保管庫ではありません。共有端末では保存しないでください。入力文章と抽出結果はページを閉じると消えます。

## 開発

v0.2.0 Phase 2は既存Workerによる個人用認証とフォーラムタグ取得を追加します。ログイン→タグ一覧取得後、イベントに最大5タグを選択できます。タグ付き投稿前にWebhookが取得元フォーラムに属するか照合します。タグなし投稿はWorkerが利用できなくても従来どおり使えます。自動判定は編集済みタイトル・説明を対象にボタン押下時だけ実行します。Phase 1のイベント5件打ち切りは仕様との不一致のため撤去し、最大5タグ制限に修正しました。

Workerの追加設定と本番デプロイ手順、API、料金比較、残作業は `worker/DEPLOYMENT.md` を参照してください。今回は本番Workerを変更していません。

本番のWeb Crypto PBKDF2上限に対する修正・既存Secret互換性・再デプロイ手順は `worker/AUTH-PBKDF2-FIX.md` を参照してください。Workerは固定依存のPBKDF2実装をバンドルし、600,000回の既存ハッシュを維持します。ブラウザ側のランタイム依存は追加していません。

外部ランタイム依存なしのVanilla JavaScriptです。GitHub Pagesではリポジトリの Settings → Pages で `main` / root を選択してください。Project Siteの相対URLで動作します。

## 検証

`node --check app.js`、`node tests-v010.js`、`node --test tests-acceptance.cjs` で検証します。受入試験は架空のWebhookを使う通信モックであり、Discordへ送信しません。

ブラウザ受入試験は `npm ci` の後に `npm run test:browser` で実行します。開発用PlaywrightとWindowsのMicrosoft Edgeを使用し、全リクエストをテスト側で制御します。実Discordへの通信はありません。30秒タイムアウトと429待機はブラウザの仮想時計で検証します。結果とスクリーンショットはGit対象外の `work/browser-acceptance/` に出力します。GitHub Pagesの `_config.yml` でテストコードと開発依存を公開対象から除外しています。

最終公開確認は `node tests/pages-verify.cjs` です。公開HTML/CSS/JSの一致、開発ファイルの非公開、PC/390px/320pxの表示、JavaScript読込とエラーなしを確認し、投稿は実行しません。

通信の制限時間は30秒です。HTTP 429はRetry-AfterヘッダーとJSONのretry_afterの長い方を待ち、最大3回まで再試行します。待機が60秒を超える場合や繰り返す場合は失敗として手動再送信に戻します。HTTP 5xx・ネットワーク/CORS障害・タイムアウト・投稿IDを確認できない成功応答は「結果不明」です。結果不明と成功済みイベントは再送信対象から除外します。Discord側で投稿状況を確認してください。

保存ONの入力変更は保存値へ反映し、OFFへの切替は保存値を削除します。WebhookはHTTPSのDiscord公式ホストのみ許可し、認証情報・ポート・クエリ・フラグメント付きのURLを拒否します。APIや通信例外の生メッセージを画面に出さず、秘密URLの漏洩を防ぎます。ただしブラウザ自身の開発者ツールのNetwork欄にPOST先が現れることは防げません。

## 制約

DiscordのWebhook URLをブラウザに入力する方式のため、URLを知る人は投稿できます。公開リポジトリにはURLを含めないでください。初期版は本文2000文字、スレッド名100文字の範囲を送信前に検証します。解析はルールベースで、認識できない文は警告します。投稿結果が不明な場合は自動再送信しません。

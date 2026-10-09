# Discord Event Poster

複数の告知文を解析し、確認したイベントをDiscordフォーラムへ投稿するツールです。
Phase 3 Step 4ではBot API投稿をローカルのモック環境へ統合しました。
本番Workerの投稿APIは未公開で、今回の作業ではデプロイしていません。

## 操作の流れ

1. 告知文を貼り付けて「解析する」を押します。
2. 抽出結果を編集し、対象イベントを選んでプレビューします。
3. 投稿時にログインし、必要な場合はフォーラムタグを取得します。
4. 確認後、イベントごとに操作キーを発行して順次投稿します。
5. 成功時はDiscordリンクを表示します。

解析とプレビューにはログイン不要です。
本番の投稿機能が無効な場合は投稿を停止し、Webhookへ切り替えません。
ブラウザへBot Tokenを渡すこともありません。

## 結果の確認と再投稿

通信障害時は同じ操作IDで状態を照会します。
成功、送信中、結果不明の操作は通常の投稿ボタンで再送しません。
安全に再試行できる操作だけ、状態を確認して同じキーで再開できます。
別の操作として投稿する場合は、対象イベントの「新しい操作として再投稿」で重複の可能性を確認します。
本文が異なる操作へのキー流用は拒否します。

操作キー、本文ハッシュ、期限、状態はこのタブのsessionStorageに保持します。
本文、イベント名、Bot Tokenは操作履歴へ保存しません。
有効期限はサーバー発行から30日です。
期限切れ情報は次の読込時に除去し、タブを閉じた場合もブラウザのsessionStorageの仕様に従って失われます。
ブラウザのセッション復元で残る場合があるため、共有端末ではサイトデータを削除してください。
最大200操作とし、保存不可や上限時は新規投稿を停止します。
ログアウトでは操作キーを消さず、再ログイン後に照会できます。
リロード後の本文復元は対象外ですが、同じ本文を再解析した場合は保持済みハッシュとの一致で同じ操作を確認します。

旧Webhook入力欄と直接送信処理は撤去しました。
旧localStorageの`discord-event-poster.webhook`だけを削除し、他の保存データには触れません。
Discord上のWebhook自体は削除していません。

## 開発と検証

`npm ci`の後、次を実行します。
ブラウザ試験はWindowsのMicrosoft Edgeを使用します。

```text
npm test
npm run test:browser
npm run test:post-runtime
npm run test:worker-runtime
npm run test:legacy-browser
npm run test:phase2-browser
```

新ブラウザ試験は正式WorkerルーターとローカルSQLite Durable Objectを通し、Discord通信だけをモックします。
旧Webhook試験は`tests/fixtures/legacy-step3/`の固定した過去実装を検証する履歴テストです。
現行フロントエンドの検証とは区別しています。
試験コード、依存、スクリーンショットはGitHub Pages公開対象外です。
公開ファイルの一致確認用`tests/pages-verify.cjs`は、本番への配信確認時に別途実行します。

## 投稿APIの有効化境界

Workerのサーバー設定`FORUM_POSTS_ENABLED`が文字列`true`の場合だけ投稿APIを有効化します。
未設定、false、リクエストヘッダー、URLパラメーターでは有効になりません。
ローカル試験ではMiniflareのテスト用bindingで設定し、既存Wrangler設定は変更しません。
本番で設定する作業はStep 5の検証とユーザー承認後に限ります。
既存Secretの再生成や認証の無効化は不要です。

詳細は[Step 4の記録](worker/docs/phase3/STEP4-RESULTS.md)、[API契約](worker/docs/phase3/API-CONTRACT.md)、[実装計画](worker/docs/phase3/IMPLEMENTATION-PLAN.md)を参照してください。

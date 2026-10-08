# Phase 2: 既存Workerへのデプロイ

対象は `discord-event-poster-api` のみ。現在のCloudflare設定は取得・変更していない。本番デプロイと実Discord照合は未実行。

## 設計

SQLite Durable Object `AuthState` を同じWorkerに追加する。全アクセスは固定名の1オブジェクトに集約する。署名だけでなく保存済みセッションも毎回確認し、ログアウトは保存状態から削除する。ログインは成功・失敗を合わせて15分に5回。並行リクエストを直列化し、別エッジでも同じ状態を参照する。最大20セッション・1時間期限、alarmで保存状態を掃除する。全体制限なので攻撃者による一時的なログイン妨害はあり得る。既存セッションは影響を受けない。

KVは無料枠があるが結果整合性のため、即時の失効と厳密な試行制限には不適合。SQLite DOは無料プランで使える（リクエスト100,000/日、13,000 GB-s/日、読み取り5百万行/日、書き込み10万行/日、保存5 GB）。個人用途では小規模、KVとDOの二重管理は不要。料金・上限超過時は認証処理を停止し、認証を迂回しない。最新料金: https://developers.cloudflare.com/durable-objects/platform/pricing/ 。Workers自体のCPU枠も適用される。PBKDF2 600,000回はローカルで検証するが、本番CPU消費は未測定。無料枠でCPU超過する場合は低い反復回数に下げず、対応プランを検討する。

## 必要な設定（値をチャットやログへ貼らない）

既存3Secretを維持する。`ALLOWED_ORIGIN` はGitHub Pagesのorigin（パス・末尾スラッシュなし）。`DISCORD_FORUM_CHANNEL_ID` は既存フォーラム。Botには読み取りとWebhook所属確認に必要な権限が必要。管理者権限があっても外部公開するのは固定フォーラムの名前・タグID・照合結果のみ。

追加Secretは `APP_PASSWORD_HASH` と `SESSION_SIGNING_KEY`。手元の非記録PowerShellで `./worker/prepare-secrets.ps1` を実行する。パスワードは非表示入力、ソルト付きPBKDF2-SHA256（600,000回）、署名鍵はランダム32バイト。値はGit対象外の `worker/work/new-secrets.json` にだけ書かれる。これを端末で安全に参照してCloudflareダッシュボードの対象Workerへ追加する。値を公開・画面共有しない。既存Secretの削除・置換は不要。設定後この一時ファイルを削除する。

## デプロイ前

1. Cloudflareダッシュボードで対象Worker名・アカウント・既存binding/route/設定を確認し、現行Hello Worldソースと設定を保全する。現行設定がある場合はこの設定ファイルへ必要部分だけマージする。既存migrationがあれば `auth-v1` をその履歴に追加する。
2. 5Secretと `AUTH_STATE` binding/migrationを確認する。Wrangler設定はSecret値を持たず名前だけ宣言し、不足時にデプロイを拒否する。
3. `npm ci`、`npm test`、`npm run test:browser`、`npm run test:phase2-browser`、`npm run test:worker-runtime`。
4. `npx wrangler deploy --config worker/wrangler.jsonc --dry-run` でバンドルを検証する。dry-runはデプロイしない。
5. 追加Secretと設定の準備完了後にのみ、所有者が `npx wrangler deploy --config worker/wrangler.jsonc` を実行する。新しいWorker名を指定しない。Wranglerは既存Secretを維持するが、管理外binding等は事前に統合する。

`wrangler secret put` は即時デプロイするため、準備中に不用意に使わない。段階的なversion操作をする場合もDO migration制約を確認する。

## API

|API|用途|
|---|---|
|POST /api/login|password JSONから1時間Bearerセッションを作成|
|GET /api/session|有効・保存済みセッションを確認|
|POST /api/logout|該当セッションの即時失効|
|GET /api/forum/tags|固定フォーラムのタグ・対応・missing/duplicates/unknown|
|POST /api/forum/webhook-check|webhookIdのみを受け、固定フォーラム内のWebhookか確認|

login以外は認証必須。Origin完全一致・署名検証・共有状態検証を併用する。Cookieは使わずsessionStorageにBearerを保存。タグ対応はメモリーだけ。Webhook URLをWorkerへ送信しない。Bot経由の投稿はしない。

## 本番受入（未実施）

Pagesからログイン→8タグ取得→対象Webhook照合を確認する。別フォーラムは拒否、ログアウトした旧tokenを別ブラウザ/エッジから使って401、期限切れ401、6回目429、Origin違い403を確認する。実投稿は利用者が内容を確認して実行する。秘密値を含む応答/Networkは記録しない。

現時点の判定は「実装・ローカル検証完了、本番設定・デプロイ・実Discord受入は残作業」。

## 今回の検証結果

2026-10-09: 既存回帰25件＋認証/安全性4件＝29件PASS、parser追加assertions PASS。Edgeの既存受入14項目PASS（1280/390/320pxを含む）。Phase 2ブラウザ通信モックPASS（手動/自動判定、5タグ上限、未設定ID拒否、ログイン、タグ取得、別フォーラム拒否、applied_tags、ログアウト、タグなし投稿）。workerd実行PASS（SQLite DO、PBKDF2 600,000回、署名セッション、ログアウト再利用拒否）。Wrangler 4.149.0 dry-run PASS。Node側の共有状態テストはstorageモック、workerd試験はローカルの実SQLite DO。本番マルチリージョン受入や本番CPU計測を実施したことにはならない。

使用したWranglerに対応するMiniflareは `5.20261006.1-alpha`。両方をlockfileと明示バージョンで固定し、runtime試験は提供されているlegacy options変換APIを利用する。互換日付はランタイムで受理・検証できた `2026-04-01` を指定した。

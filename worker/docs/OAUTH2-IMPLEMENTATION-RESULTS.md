# Discord OAuth2移行 実装・ローカル検証結果

日付: 2026-10-12（日本時間）
ブランチ: event-poster-v2
開始コミット: 720cd61968ea65bcc75af271135dbfc1ac9c6eef
判定: ローカル実装・検証 PASS。本番移行 NOT TESTED。

## 実装した内容

- Worker confidential clientのAuthorization Code Grant / identifyのみ。
- Workerが取得したDiscord IDとSecretの許可IDを文字列で完全一致比較。不一致・欠落設定・上流失敗は拒否。
- 延長なしの3,600秒セッション、新専用署名鍵、新形式、新DO保存領域。
- /api/login撤去、旧Bearer常時拒否、旧sessions/attemptsだけを移行時に削除。旧認証fallbackなし。
- 一回限りstateとブラウザCookie、開始タブverifier、60秒handoff。チケット消費はセッション保存より先に永続化し、保存失敗時もチケットを再利用させない。
- callback以外のOrigin/Host制約維持、固定OAuth通信先、redirect拒否、本文と時間上限、共有レート制限、CSP、非キャッシュ、秘密を含めないエラー。
- パスワード欄をDiscordログインボタンへ変更。旧セッション保存だけを除去し、既存操作履歴を保持。
- 既存DO identity / binding / class / migration / 投稿署名鍵 / 操作キーv1 / principal / 投稿状態・クールダウン・二重投稿防止を維持。
- パスワード用PBKDF2実装・依存・現行テストを撤去し、新OAuth試験へ置換。旧Webhook固定fixtureの履歴試験は保持。
- Wranglerの新必須設定名を記載。Cloudflareの実Secretは追加・変更・削除していない。

## 最終テスト結果

| 検証 | 結果 |
| --- | --- |
| npm test | PASS 129件、FAIL 0。解析スモークもPASS |
| npm run test:browser | PASS 22件。正式Worker + SQLite DO + Edge、OAuthと投稿通信はモック |
| npm run test:worker-runtime | PASS。バンドル済みworkerd、本人ログイン、旧認証拒否、署名改ざん・logout拒否、callbackとhandoffの並行消費 |
| npm run test:post-runtime | PASS。同一操作並行で1回送信、上限、再起動保持、read-only、logout、5xx/timeout非再送、429共有待機 |
| npm run test:migration-runtime | PASS。同じ永続SQLite DOの旧保存形式から切替、旧セッション拒否、既存操作署名・成功結果保持、再送0回、再起動保持 |
| npm run test:legacy-browser | PASS 14件。旧固定Webhook fixtureの履歴検証 |
| npm run test:phase2-browser | PASS。旧固定fixtureのタグ・所属確認・認証履歴検証 |
| node --check app.js / poster-client.js | PASS |
| git diff --check | PASS（通常のリポジトリ改行設定で実施） |
| 1280 / 390 / 320px | PASS。横スクロールなし。390px画面も目視確認 |

OAuth試験には本人以外、期限境界、許可ID変更、state/Cookie mismatch、一時情報再利用、偽postMessage origin/source、不正型、キャンセル、ポップアップ遮断、上流3xx/429/5xx/timeout/過大本文、不正scope、保存失敗、DO再生成、alarmを含む。
最終ブラウザ検証ではOriginを試験側で作らず、ブラウザが付けたOrigin/Cookieを検証した。
永続移行試験は旧保存形式を作る専用fixtureを用いた。本番DOを読み書きした試験ではない。

途中のブラウザ試験で、補助処理がstartのredirectを追い公開DiscordログインページをGET取得した問題を発見した。実Secretは使わず、実認可コード交換・実ログイン・実投稿は行っていない。
補助処理をredirect:manualに修正し、Playwrightのredirect interception制約に対して各ホップを新規ナビゲーションとしてモックした。最終試験ではDiscord外部通信0件。
このモックは実DiscordページのopenerヘッダーやCookie挙動を再現した証明にはならない。

## 変更ファイル

認証と投稿への接続:

- worker/src/auth-session.mjs（新規）
- worker/src/oauth-state.mjs（新規）
- worker/src/oauth-handler.mjs（新規）
- worker/src/index.mjs
- worker/src/post-handler.mjs
- worker/src/post-state.mjs

公開フロント:

- index.html
- app.js
- poster-client.js
- styles.css

設定・依存・文書:

- worker/wrangler.jsonc
- package.json
- package-lock.json
- README.md
- worker/docs/phase3/API-CONTRACT.md
- worker/docs/OAUTH2-MIGRATION.md（新規）
- worker/docs/OAUTH2-IMPLEMENTATION-RESULTS.md（本書、新規）

試験:

- tests-acceptance.cjs
- tests/browser-acceptance.cjs
- worker/tests/oauth.test.mjs（新規）
- worker/tests/oauth-fixtures.mjs（新規）
- worker/tests/oauth-mock.mjs（新規）
- worker/tests/legacy-auth-state-entry.mjs（新規、旧保存形式のfixture）
- worker/tests/oauth-migration-runtime.mjs（新規）
- worker/tests/post-fixtures.mjs
- worker/tests/security.test.mjs
- worker/tests/forum-posts.test.mjs
- worker/tests/post-state.test.mjs
- worker/tests/release-gate.test.mjs
- worker/tests/runtime-entry.mjs
- worker/tests/runtime.mjs
- worker/tests/post-runtime-entry.mjs
- worker/tests/post-runtime.mjs
- worker/tests/pbkdf2-production.test.mjs（旧PW認証試験を削除）

## 作業境界・残課題

既存ローカルmainにはworker/wrangler.jsoncの変更とbakがあったため、それらを保護して同じGitリポジトリのevent-poster-v2専用作業ツリーを使用した。
mainへのマージ、本番デプロイ、Cloudflare Secrets変更・削除、Developer Portal変更、実Discord投稿は未実施。
コミットはローカル開発ブランチのみ。pushとPR作成はしていない。
本番の本人ログイン、Discordの実ヘッダー/opener/Cookie動作、公開フロント配信の一致、既存本番操作の照会はNOT TESTED。
旧Stage 1 wrapperは当時の設定とVersionで固定されているため、OAuth反映には流用できない。安全制約を緩めず維持した。

本番への適用順序と設定名は[OAuth2移行手順](OAUTH2-MIGRATION.md)に記載した。
承認後にPortalのRedirect URIと新しいOAuth設定を安全に追加し、既存Secrets・DO・投稿署名鍵を保持してWorkerとフロントを反映する。
投稿停止モードで本人ログインと旧セッション拒否、既存操作のGET照会を先に確認する。投稿有効化・実投稿は別承認が必要。

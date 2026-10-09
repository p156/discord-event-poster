# Phase 3 Step 5 — Release Candidate Gate

検証日：2026-10-10（日本時間）。対象は`p156/discord-event-poster`のmain、基準は`9e00e677e3546064177337330edef2d2c9913e0e`。

## 1. Release Candidate判定

**CONDITIONAL PASS**。
ローカル・モックで実施したセキュリティ、二重送信防止、共有制限、ブラウザE2E、回帰テストはPASS。
本番Bot投稿権限、実Discord receipt、本番CPU使用量、配信済みPagesとWorkerの一致は未検証であり、PASSに含めない。
Step 6はユーザー承認後に開始する。本番投稿APIの設定は変更していない。

## 2. 実行したテスト

| コマンド・確認 | 結果 | 証拠の範囲 |
| --- | --- | --- |
| `npm test` | PASS、113/113、失敗0。別途パーサー試験PASS | Node、現行クライアント、認証、投稿アダプター、状態、cooldown、Release Gate。旧Webhook履歴試験を含む |
| `npm run test:browser` | PASS、20ケース | Playwright、正式ルーター、ローカルSQLite DO、Discordのみモック |
| `npm run test:worker-runtime` | PASS | workerd、600,000回PBKDF2、production Web Crypto上限制約の再現、ログイン・セッション・ログアウト |
| `npm run test:post-runtime` | PASS | workerd、同一キー並列、共有10枠、SQLite再起動、読み取り専用停止、失効、5xx・timeout・429 |
| `npm run test:phase2-browser` | PASS | 固定した旧実装のPhase 2履歴試験。現行Webhook投稿の証拠ではない |
| `npm run test:legacy-browser` | PASS、14ケース | 旧Webhook履歴、HTTPエラー、通信障害、部分失敗、幅1280/390/320 |
| `node --check` | PASS | poster-client.js、Worker入口、現行ブラウザ試験 |
| `git diff --check` | PASS | 空白エラーなし。既存改行形式の警告はあり |
| Wrangler `deploy --dry-run` | PASS、85.21 KiB / gzip 21.46 KiB | Secret値なしの専用設定によるbundle確認。デプロイなし |

修正後に全回帰コマンドを実行した。
その後に追加したworkerd読み取り専用試験も、投稿runtime全体を再実行してPASSした。
Miniflare v5の設定形式に合わせるまで追加試験の設定エラーが2回発生したが、最終実行では解消済み。
この設定エラーをproductionコードの障害とは扱わない。

## 3. 発見した問題

1. 送信前のDO cooldown確認が遅延すると、通信期限切れを返した後に外部fetchへ進む可能性があった。
   AbortSignalを無視するモックで、期限切れ後の送信数1を再現した。
2. 投稿機能を完全に無効化すると状態GETも404になり、ロールバック後の結果確認ができなかった。
3. クライアント側操作メタデータの正規表現・日付検証で、文字列への型変換に依存する箇所があった。
   配列型のID等を受け入れないようにする必要があった。

## 4. 修正内容

- cooldown確認前後でAbortSignalを検証し、期限切れ後にDiscord fetchを開始しない。
- サーバー設定`FORUM_POSTS_ENABLED=read-only`を追加し、認証付き状態GETだけを維持する。
  新規intent・投稿POSTは404。未設定時の全投稿API無効化は維持する。
- 操作ID、payloadHash、issuedAt、expiresAtに明示的な文字列型検証を追加する。
- 回帰試験とAPI契約・READMEを更新する。

既存のSecret形式・操作キー形式・認証方式・DO bindingは変更しない。
追加capability`forumPostStatus`は状態照会の可否を表す。既存`forumPosts`は書き込み許可だけを表す。

## 5. セキュリティ検証

未認証、不正Bearer、期限切れ、ログアウト後、Host/Origin不一致、HTTP、禁止method、不正preflightを拒否した。
署名改ざん、操作IDの流用、異なる本文、期限切れキーも拒否する。
内部投稿・cooldown操作は有効なセッションと用途分離した署名を要求する。
別の有効セッションは同一個人ownerとして履歴照会・同一操作要求を行えるが、重複送信は発生しない。

投稿先はWorker設定のフォーラムに固定し、任意URL・Bot Token・Webhook URLを投稿JSONから受け取らない。
メンション抑制、manual redirectと3xx拒否、10秒通信期限、64KiB応答上限、不正receipt拒否を維持する。
テスト用秘密値が投稿応答・操作履歴へ出ないことを検証した。
Discordエラー本文、Authorization、パスワード、本文を診断へ追加していない。
本番Secret値・本番ログは取得していないため、その実環境監査を実施済みとは扱わない。

PBKDF2-SHA256 600,000回を維持する。
純JS実装とproduction Web Cryptoの100,000回上限制約再現を検証済みで、APP_PASSWORD_HASH再生成は不要。
SESSION_SIGNING_KEYも変更しない。

## 6. 二重投稿防止と永続化

同一キーの連続・並列要求、異なるライブセッション、実ブラウザ2タブでDiscord POSTが1回となった。
ブラウザ2タブのHTTP要求自体は2回だが、2回目は保存済み結果を返した。

送信観測点で` sending`状態、attempt=1、共有slot=1、storage.sync完了を検証した。
slot確保とsending保存は同一transaction内で行い、ネットワーク通信はtransaction外で行う。
保存障害時は送信を開始しない。
送信開始境界以降のクラッシュ、通信断、5xx、不正receipt、結果保存失敗はunknownとなり、自動再送しない。
期限前の未送信preparing lease切れは安全な再試行と区別する。

実SQLiteを保持してMiniflare/workerdを破棄・再作成し、認証・成功履歴・quotaを復元した。
応答消失後のGET、sending期限後のunknown、30日満了・履歴削除・期限切れ410は時計制御した状態試験で検証した。
実時間で30日待機する検証や本番DOの強制再起動は実施していない。
履歴は30日経過時に照会拒否し、alarm/request cleanupで段階的に削除する。物理削除が満了時刻ちょうどに完了する保証はない。
期限切れキーから新操作を暗黙に発行しない。
意図的な再投稿は対象イベントの確認と新操作IDを要求する。
Discord外部APIに対する厳密なexactly-once保証は主張しない。

## 7. レート制限

全利用者・セッションで共有する10件/60秒のsliding windowを検証した。
10件許可、11件目429、Retry-After、60秒境界、並列競合、再起動後維持、時計巻き戻り、保存障害時fail-closedはPASS。
GET・保存結果のreplayは枠を消費しない。入力・タグ検証失敗も送信枠を消費しない。
送信開始として永続化した試行は、429・unknown・実fetch前クラッシュでも枠を返さない。
APP_RATE_LIMITEDとDISCORD_RATE_LIMITEDを区別する。

Discord global cooldown、経路別cooldown、実際のbucketヘッダーとmajor IDの組み合わせを検証した。
bucket未確認の異なる経路を推測で統合しない。
タグ取得・旧Webhook所属確認と投稿は共有DOのcooldown確認を通り、待機中にDiscordへ送信しない。
Worker内の自動HTTP再送はない。明確な429に対するクライアント側の限定的な同一キー再要求は、結果不明の再送とは区別する。

## 8. ブラウザE2E

現行20ケースPASS。
ログイン不要の解析・プレビュー、手動編集、タグ自動判定・手動変更、未認証投稿停止、確認、成功リンク、順次投稿を検証した。
3イベント中の中間500は2成功・1unknownとなり、イベント状態を混同せずunknownを再送しなかった。
送信payloadと編集後プレビューの一致、初回確認キャンセル、2タブ同一操作、二重クリック、リロード照会、認証切れ、再投稿確認を検証した。
sessionStorageが利用できない場合はDiscord送信前に停止した。
HTML/XSS文字列と不正URLを試験し、スクリプト実行・javascript URLの利用を認めなかった。
外部リンクの安全な属性とDiscordリンク形式を検証した。
PC幅1280、スマートフォン相当390/320で主要操作・横幅を確認した。
既存Webhook保存値を新フロントエンドが利用せず、ブラウザからWebhook直送が発生しないことを検証した。

## 9. 本番構成の事前監査

ローカル設定の投稿flagは未設定であり、投稿APIはdefault-off。
正式入口は`worker/src/index.mjs`、既存`AUTH_STATE`/`AuthState`/`auth-v1` SQLite構成を維持する。
既存singleton名`personal-auth-v1`と用途別storage keyを維持するため、新Migrationは不要。
必要Secret名は既存5件のみ。値・実アカウント登録状態は確認していない。
固定forumはDISCORD_FORUM_CHANNEL_IDから取得する。値は記録しない。
OriginはALLOWED_ORIGINと完全一致、HostとHTTPSは既存境界で検証する。
公開予定Originは`https://p156.github.io`、Worker Hostは`discord-event-poster-api.monma5435.workers.dev`。
実Secretが予定値と一致することは未検証。

Pagesはindex.html、app.js、poster-client.js、styles.css等の静的配信を前提とする。
`_config.yml`はworker、tests、node_modules、work、package/テスト関連ファイルを除外する。
これは設定監査であり、実際の公開物・Jekyll build・CDNへの反映確認ではない。
WorkerとPagesの不一致時、新UIはcapability/404を扱って停止し、Webhookへfallbackしない。
配信済み旧UIを含む実際の組み合わせはStep 6で確認する。

dry-runは既存設定と同じbinding・migration・Secret名を持つ、値なしのignored専用設定を使用した。
元のWrangler設定と.bakは変更・commitしていない。
CPUのローカル実測値と本番CPU limitは同一視しない。
[Workers制限](https://developers.cloudflare.com/workers/platform/limits/)ではFree HTTP CPUは10ms、Paidは既定30秒・設定上限5分。
認証のPBKDF2はDO内で実行する。[DO制限](https://developers.cloudflare.com/durable-objects/platform/limits/)は既定30秒のCPU制限と設定可能な上限を別途定める。
本番契約・実測CPU・混雑時応答はStep 6確認事項。ローカルログインのwall timeをCPUの証拠として使わない。

## 10. 残存リスク

- Botがタグを読めることは投稿権限の証明ではない。実権限・実receiptは未検証。
- 本番CPU、Cloudflare設定、Secret名の登録、公開物の版一致は未検証。
- 外部送信とDO保存を分散transactionにできないためunknownが残る場合がある。安全側に再送しない。
- ブラウザ操作メタデータはsessionStorageで最大30日・最大200件。別端末への自動引継ぎ、本文の永続保存は行わない。
- intent/GETの濫用対策は投稿10枠とは別の今後の運用課題。個人パスワード・セッションを共有しない運用を維持する。
- ローカルworkerdは本番サービスの再起動、回線、CPU計測を完全には再現しない。

## 11. Step 6で必要な操作

ユーザー承認を得た後、既存Workerの契約・制限・設定名・bindingを値非露出で確認する。
新WorkerやMigration、Secret再生成は不要。
承認された候補を既存Workerへデプロイし、まず認証・タグ取得・投稿default-offを確認する。
別途承認された有効化で`FORUM_POSTS_ENABLED=true`を設定し、許可された1イベントで権限・receipt・リンク・同一キーreplayを確認する。
Pages配信ファイル、認証、PC/スマートフォン操作、CPU、状態照会を確認する。
Discord実投稿・既存Webhook削除は今回実施していない。Webhook削除は本番動作確認後の明示承認による。

## 12. 停止・ロールバック

新規投稿を停止するときは、承認後に既存Workerの設定を`FORUM_POSTS_ENABLED=read-only`へ変更し反映する。
状態GETと認証を維持してunknown/送信中の結果を確認する。intent/POSTが404であることを確認する。
全API停止が必要な場合はflagを未設定/falseにできるが、状態GETも止まることを明示する。
受理済み処理が完了する可能性はある。設定変更で進行中送信をキャンセルしたとは判断しない。
DO binding、singleton名、保存履歴、共有quota、署名鍵を保持する。
既存データの削除、新DOへの切替、鍵の再生成で復旧しない。
旧Webhook直送UIへ戻さず、安全な停止UIを維持する。
unknownを自動再送せず、Discordで結果を手動確認してから明示的な再投稿を判断する。

## 13. 変更ファイル

- README.md
- package.json
- poster-client.js
- tests-acceptance.cjs
- tests/browser-acceptance.cjs
- worker/src/discord-cooldown.mjs
- worker/src/index.mjs
- worker/tests/release-gate.test.mjs
- worker/tests/post-runtime.mjs
- worker/docs/phase3/API-CONTRACT.md
- worker/docs/phase3/STEP5-RESULTS.md

既存ローカルWrangler設定と.bak、ignored dry-run設定・bundleはcommit対象外。
検証前後のSHA256はwrangler.jsoncが`D4D5326B330B36950FD47320E246E46C9A9A27626055614053A77445B620505F`、.bakが`7F28CAB37EACF66ED31162FF08640D74B18878B9B3CFF75EBB278286F925723F`で一致した。

## 14. Commit SHA

候補コードのcommitとpushを確認後、この節を更新する。
自己参照を避け、検証済みコードcommitと、その結果を記録する文書のみのcommitを区別する。

## 15. push結果

確認後に記録する。本番デプロイ・Discord実通信・Step 6は実施していない。

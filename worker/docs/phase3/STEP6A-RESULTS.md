# Phase 3 Step 6A 本番環境監査と移行計画

監査日：2026-10-10（日本時間）。
対象：`p156/discord-event-poster`、main。
開始時のHEADと取得したorigin/mainはいずれも`305b28f409b69d41d9f629e82ab0c72cc28ee2e6`。
RCコードは`a8c19be063bcd440bf424a815da78c7bd4fae67d`で、両commit間のproductionコード差分はない。
今回の変更は本書だけであり、Step 6Bを実行する承認ではない。

## 1. 本番環境監査結果

**READY WITH CONDITIONS**。
Pagesの公開設定、主要配信ファイル、公開Workerへの未認証アクセス、RCビルドを確認した。
Cloudflare管理認証がこの環境では利用できず、本番binding、Migration、登録Secret名、契約、投稿flag、現行versionは未確認。
Discord Botの実効権限も未確認。
これらをStage 1の書き込み前条件とし、確認できるまでデプロイしない。
重大な不整合を確認したわけではないためBLOCKEDとは判定しないが、この判定だけで本番更新を開始できるわけではない。

本番への通信は公開静的ファイルGET、Workerの未認証GETとpreflight OPTIONSだけ。
ログイン、操作キー発行、投稿、ログアウト、Discordへの直接通信は行っていない。
Cloudflare管理コマンドは読み取り操作を試みたが、認証不足で情報を取得できなかった。

## 2. Cloudflare設定の確認結果

| 項目 | 結果 | 確認方法と限界 |
| --- | --- | --- |
| 管理アカウント認証 | この実行環境では利用不可 | whoamiはexit 1。非対話環境で認証が必要との結果。本人アカウントの有無やブラウザログイン状態とは別 |
| Worker名 | ローカル構成と指定URLで確認 | discord-event-poster-api。管理API上の所属アカウントは未確認 |
| 公開URL | 到達確認 | https://discord-event-poster-api.monma5435.workers.dev |
| 現行deploy/version | 未確認 | deployments listが認証不足で失敗 |
| 本番AUTH_STATE binding/class/namespace | 未確認 | ローカルはAUTH_STATE / AuthState。401応答だけでnamespaceや保存内容を証明しない |
| 本番Migration tag | 未確認 | ローカルはauth-v1。実際の適用履歴は取得できず |
| vars設定名 | 未確認 | settingsを取得していない |
| Secret登録名 | 未確認 | secret listが認証不足で失敗。値取得は実施していない |
| 本番FORUM_POSTS_ENABLED | 未確認 | 未認証GET /api/forum/postsは404だが、旧版の未実装とflag無効を区別できない |
| Workers契約とCPU設定 | 未確認 | 管理情報を取得できず |
| 認証API到達性 | 確認 | 正当Originの未認証session GETは401。不正Originは403。login preflightは204 |
| 本番ログイン成功とPBKDF2実行 | 未検証 | パスワード入力やlogin POSTを行っていない |

認証確認の生出力に含まれ得るメールやアカウント情報を報告へ出さず、利用可否だけを記録した。
ログイン、新tokenの発行、仮アカウント、Secretファイルの読み取りは行っていない。
Step 6B前に、ユーザーが管理画面または安全に認証されたローカル環境で設定名とmetadataを確認する。
資格情報をチャットやGitへ渡さない。
設定APIを使う場合も、Secret値を含むエンドポイントやWorkerコードのダウンロードを避ける。

## 3. Discord Bot権限の確認結果

実Bot Token、フォーラムIDのSecret値は取得していない。
Bot接続済みの読み取り専用管理手段がないため、実ロール、channel overwrite、forum flags、moderated tagは未確認。
以前のタグ取得成功はユーザーからの情報であり、今回再検証したものではない。

| 権限 | 公式仕様と今回の判断 | 実設定 |
| --- | --- | --- |
| View Channel | 親フォーラムへのアクセスの確認対象 | 未確認 |
| Send Messages | フォーラム作成エンドポイントで必要 | 未確認 |
| Send Messages in Threads | 作成済みスレッドへの追加メッセージ用。作成エンドポイントの必須条件とは分ける | 未確認。追加投稿は今回の機能範囲外 |
| Create Public Threads | フォーラム作成では無視されるため、今回のために追加しない | 未確認。必須Gateにしない |
| Manage Threads | moderatedタグの付与に必要。通常タグだけならそのために追加しない | タグmoderated状態も未確認 |

フォーラム作成は`POST /channels/{channel.id}/threads`で、Send Messagesを要求し、Create Public Threadsを使用しない。
成功はthread channelとnested messageで返る。[Discord Channel公式仕様](https://docs.discord.com/developers/resources/channel#start-thread-in-forum-or-media-channel)
作成済みthreadへの発言権限は別にSend Messages in Threadsが必要。[Discord Threads公式仕様](https://docs.discord.com/developers/topics/threads#permissions)
moderatedタグはManage Threadsを要求する。[Forum Tag公式仕様](https://docs.discord.com/developers/resources/channel#forum-tag-object)

読み取り権限の確認では@everyone、Botの全role、親channel overwrite、Administrator、timeout、タグrequired/moderatedを合わせて評価する。
Developer Portalの招待permission値だけを実効権限と見なさない。
権限が不足しても今回追加しない。必要なら理由と最小権限を提示し、別承認を得る。
既存BotがAdministratorを持つ場合も新たな権限追加の理由にはしない。
最終的な投稿可否はStage 3の承認された1件で確認する。

## 4. GitHub Pages配信状況

GitHub REST APIで、公開元main、公開ディレクトリ`/`、build_type=legacy、https_enforced=true、status=builtを確認した。
最新buildのcommitは基準`305b28f409b69d41d9f629e82ab0c72cc28ee2e6`。
build作成時刻は2026-10-09T17:06:52Z、更新時刻は17:06:59Z。
リポジトリ管理の.github workflowはないが、GitHub提供の`pages-build-deployment`（dynamic/pages/pages-build-deployment）がactive。
したがって「GitHub Actionsがない」ではなく、「独自workflowはなく、branch公開をGitHubのworkflowで実施」と整理する。
mainへの通常pushは既存設定でPages自動更新を起動する。[GitHub Pages公開元の公式仕様](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
今回の文書pushもこの既存自動処理を起動し得るが、Pages設定もfrontendも変更しない。
CloudflareのGit連携による自動deploy有無は管理認証不足で未確認。
独自GitHub ActionsにWorker deployがないことだけで、Cloudflare自動deploy不存在を証明しない。

公開URL：https://p156.github.io/discord-event-poster/
index.html、app.js、poster-client.js、styles.cssはHTTP 200で、CRLFをLFにそろえたSHA256がローカルmainと一致した。
レスポンスはCache-Control: max-age=600、Age: 0、Last-Modified: Fri, 09 Oct 2026 17:07:45 GMT。
監査時点では反映遅延による差異を確認しなかったが、他端末のキャッシュまで一致を保証しない。
_config.ymlはHTTP 404。Jekyll設定が公開資産にならない結果であり、不一致の不具合とは扱わない。
その内容はmain上で確認した。
worker/src/index.mjs、worker/wrangler.jsonc、worker/docs/phase3/STEP5-RESULTS.mdもHTTP 404で、Workerディレクトリの非公開を代表パスで確認した。

`node tests/pages-verify.cjs`はPASS。
主要4資産一致、開発用7パスの404、実Edgeブラウザの幅1280/390/320で解析とプレビューがPASS。
JS例外とconsole errorは0で、WorkerやDiscordへの通信はなく、公開静的GET以外を遮断している。
スマートフォン相当幅の検証であり、Android実機受入ではない。
ローカル証跡はignoredのwork/browser-acceptance/pages.jsonとscreenshots。

新UIはすでに配信済み。
コードはsession.capabilities.forumPosts===trueとapiVersion===1を投稿前に要求し、旧Workerのcapability欠落や無効設定で停止する。
新intentで404を受けた場合もPOSTS_DISABLEDとして停止し、Webhookへfallbackしない。
この境界の動作はStep 5モック試験と今回の配信ソース一致で裏付けられる。
本番でログインしてcapability無効を確認する結合検証は未実施。

## 5. Workerデプロイ構成

| 項目 | RCローカル設定 |
| --- | --- |
| 対象 | 既存discord-event-poster-api、別Workerを作らない |
| config | worker/wrangler.jsonc。既存ローカル差分を保持 |
| entrypoint | worker/src/index.mjs |
| compatibility date | 2026-04-01 |
| DO binding/class | AUTH_STATE / AuthState |
| singleton | personal-auth-v1 |
| migration定義 | auth-v1、new_sqlite_classes: AuthState。新migration追加なし |
| 必要Secret名 | ALLOWED_ORIGIN、DISCORD_BOT_TOKEN、DISCORD_FORUM_CHANNEL_ID、APP_PASSWORD_HASH、SESSION_SIGNING_KEY |
| vars | ローカルでは未定義。limits.cpu_msも未指定 |
| Origin | ALLOWED_ORIGIN完全一致。公開サイトのOriginはhttps://p156.github.io（pathを含めない） |
| forum | DISCORD_FORUM_CHANNEL_ID固定。実値の取得なし |
| 投稿flag | サーバー設定の文字列trueだけでwrite有効。未設定/falseは全投稿API拒否、read-onlyは保護された状態GETだけ |
| routing | HTTPSと固定Worker Host。任意URL、header、queryから有効化できない |

新Migration不要という判断は、本番が同じ既存class、namespace、auth-v1に一致する場合に限る。
本番で差異があれば停止して再設計する。deployによる新class/namespace作成やmigration適用を許容しない。

今回のdry-runはStep 5の値なし専用設定を再利用し、mainの相対参照だけが異なる。
既存Wrangler設定、.bak、.dev.vars、.envを変更または読み取っていない。
dotenv自動読取を無効にして`wrangler deploy --dry-run`を実行し、85.21 KiB / gzip 21.46 KiB、AUTH_STATE bindingで成功した。
本番登録状態、CPU、権限を確認する試験ではない。

デプロイでdashboard由来のvarsを消さないため、Step 6Bでは`--keep-vars`を使用し、投稿flagのみ承認された値で明示する。
ローカルflag未設定だけでは、keep-varsで保持する本番flagの無効を保証できない。
Secretはdeployで削除されないが、Secretファイルの添付、secret put/bulk、鍵の再生成は行わない。[Wrangler公式仕様](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)

## 6. CPU制限と未確認事項

| 区分 | 公式仕様 | 現在の契約/実測 |
| --- | --- | --- |
| Workers HTTP CPU | Free 10ms、Paid既定30秒、設定上限5分 | 未確認 |
| SQLite DO CPU | 既定30秒、設定で上限5分 | 本番cpu_msとCPU実測は未確認 |
| Workers daily requests | Free 100,000/日、Paidは同じ日次上限なし | 未確認 |
| subrequests | Free 50/request、Paid既定10,000/request | 未確認 |
| incoming/outgoing待機 | CPUとwall timeは別。ネットワークやstorage待機はCPUへ算入しない | ローカルwall timeを本番CPU証拠にしない |

[Workers公式制限](https://developers.cloudflare.com/workers/platform/limits/)と[Durable Objects公式制限](https://developers.cloudflare.com/durable-objects/platform/limits/)を確認した。
公式の一般仕様と現在のアカウント設定を同一視しない。
PBKDF2 SHA-256 600,000回はAuthState内の純JS計算で、外側WorkerのFree 10msとDOの制約を分けて評価する。
APP_PASSWORD_HASHの互換性と既存SESSION_SIGNING_KEYは維持し、再生成しない。
本番CPU使用量は管理認証不足で取得していない。

RCにはDiscord1通信10秒、投稿JSON読取5秒/16KiB、Discord応答64KiB、frontend15秒、prepared context15秒、sending判定120秒の独自制限がある。
複数の準備GETとDO通信を含む全体時間が、単一通信10秒になるとは保証しない。
frontend期限でunknown/unconfirmedとなった場合は状態GETで確認し、新キーへ自動切替しない。
DO保存はtransactionとsyncを待ち、失敗時は送信しない。
storage待機がCPUに含まれないことは、保存完了や短いwall timeの保証ではない。
Stage 1で本番認証のCPUと制約を確認し、Stage 3では投稿経路も確認する。
ログ全文や本文、Authorization、Cookie、Secretを採取せず、CPU/wall、status、固定error分類だけを記録する。
観測機構の新規有効化が必要なら追加承認を得る。既存observability:falseを今回変更しない。

## 7. Step 6BのStage別実行計画

以下は計画であり、記載コマンドは今回実行していない。

### Stage 1 Worker更新

**承認**：対象Worker、RCコード、停止設定、設定保全方法を明示してユーザー承認を得る。
まず管理アクセスを確認し、現行version/deployment、account、DO classとnamespace、migration tag、vars名、Secret名、公開URL、契約を値非露出で記録する。
Cloudflare側Git連携や自動deployがある場合は、その実行対象と移行中の競合回避方法も確認する。
固定Origin/forumの妥当性はユーザーの管理画面確認または認証済みtagsの対象照合で確認し、Secret値を報告へ載せない。
この事前確認は実デプロイの前に完了させる。
新DO作成、新migration、未知binding削除、既存vars消失が見込まれるなら停止する。

RCコードが変わっていないこと、ローカルWrangler差分を保全したこと、dry-run成功を確認する。
承認済みStage 1では投稿flagを文字列falseに明示し、default-offを保証して更新する。
予定コマンド（repoルート、管理設定の一致確認後に限る）：

```powershell
npx wrangler deploy --config worker/wrangler.jsonc --name discord-event-poster-api --keep-vars --var "FORUM_POSTS_ENABLED:false" --strict
```

strictのremote差異警告を無視して再実行しない。
limits、routes、observability等の差異も先に確認し、必要な保全が承認されるまで停止する。
更新後はversionとDOの継続、認証、タグ取得、capabilities.forumPosts=falseを確認する。
正当Originの投稿経路のpreflight/状態GETが404であることを先に確認する。
必要なPOSTの404確認はこのStageの承認に含め、正当なpayloadで安全境界を確認する。Discord送信を許可する試験にはしない。

**完了条件**：既存Workerの候補更新、保存namespace不変、認証とtags成功、投稿無効、CPU問題なし。
**中止条件**：事前管理情報未確認、設定差異、Secret不足、認証失敗、別forum、migration要求、データ消失、CPU超過、予期せぬ投稿有効。

### Stage 2 投稿API有効化

**承認**：Stage 1の結果提示後、投稿API有効化だけを別承認する。
同じ候補コードとDOを維持し、keep-vars付きでflagを文字列trueに変更して反映する。
実施コマンドはStage 1と同じで、varだけ`FORUM_POSTS_ENABLED:true`とする。
固定Origin/Host、未認証401、不正Origin403、capability true、正当preflightを確認する。
未認証POSTで認証拒否を確認する場合も、Stage 2の承認範囲で実行する。
認証付き投稿POSTやintent発行から実送信する試験はStage 3まで実施しない。
この時点で公開サイトの認証済み利用者は投稿可能になるため、ユーザーへ有効化時刻と試験中の手動投稿停止を伝える。

**完了条件**：同一コードで有効化、認証境界とCORS確認、既存Secret/namespace維持。
**中止条件**：認証回避、設定不一致、version不一致、想定外アクセス、DO障害。
問題時は停止手順の承認範囲に従ってread-onlyへ切り替える。

### Stage 3 Discord実投稿1件

**承認**：forum、テストイベントの題/本文/タグ、最大1スレッド作成、同キーreplay、失敗時停止を別承認する。
8名称対応とrequired/moderated条件を検証し、1イベントだけintentを発行して端末保存する。
同じsnapshotとticketで1回送信する。
receiptのguild、forum、thread、messageと固定URLを検証し、Discord上の表示を確認する。
状態GETと同キーPOST replayで同じIDsが返り、新スレッドが増えないことを確認する。
CPUとerror分類を安全に記録する。
5xx、timeout、応答欠落、結果保存失敗はunknownとして停止し、新キーで試し直さない。
429は待機情報を記録して段階を止め、予定外の自動retryを発生させない試験方法を選ぶ。
成功threadの削除も今回の承認に含めず、必要なら別承認する。

**完了条件**：実効投稿権限、1thread、正当receipt/URL、同キーreplayで追加0、秘密漏えいなし。
**中止条件**：403等の権限不足、別forum、不正receipt、unknown、二重作成、保存障害、CPU超過、秘密漏えい。
異常時はread-only停止を優先し、結果確認を先に行う。

### Stage 4 公開サイト受入

**承認**：PCとAndroid実機でのログイン、解析、プレビュー、タグ選択、結果照会を別承認する。
公開4資産とmain、Workerのversion/capabilityを再確認する。
PCの操作キーとreceiptを保持し、同じ操作の結果表示を検証する。
Androidでは新intentを発行して投稿しない。解析、プレビュー、tags、ログインを確認し、必要なら既存receiptの表示を安全に確認する。
sessionStorageは端末間共有ではないため、AndroidがPCの操作を自動復元できるとは扱わない。
Androidで独立した実投稿受入が必要なら、追加1件の明示承認を改めて得る。
キャッシュの古い資産があれば読み込み直して一致を確認し、旧Webhook UIへ戻さない。

**完了条件**：PCとAndroid実機の主要操作、版一致、成功リンク/状態表示、誤再送なし。
**中止条件**：キャッシュ混在、操作保存不可、XSS、誤再送、別イベント状態混同、配信版不一致。
スマートフォン幅のローカル試験をAndroid実機PASSへ置き換えない。

## 8. 各Stageの承認ポイント

Stage 1更新、Stage 2有効化、Stage 3最大1件の実投稿、Stage 4実機受入をそれぞれ独立して承認する。
Stage 2/3の承認時に、障害が起きた場合のread-only緊急停止設定反映まで許可するかも確認する。
停止変更の承認がない場合、エージェントは書き込みを停止してユーザーへ要求する。
Stage 3でunknownになった場合の新キー再投稿、Discord権限変更、thread削除、旧Webhook削除は自動承認に含めない。
Webhook削除は本番受入後の別指示まで行わない。

## 9. 共通中止条件

本番のnamespace/class/migrationがRC前提と違う、認証が使えない、設定を安全に保全できない場合はStage 1を書き込み前に止める。
秘密漏えい、認証回避、二重投稿、永続化前送信、共有制限回避を確認した場合は以後のStageへ進まない。
結果不明、429、5xx、CPU/保存障害では新キーを作って試験を続行しない。
厳密なexactly-onceを保証したと判断しない。

## 10. ロールバック手順

承認済み停止操作で、新規投稿を止める`FORUM_POSTS_ENABLED:read-only`を同じRCコードへ反映する。
Stage 1のkeep-vars/strict付きコマンドのvarだけをread-onlyにする。
操作発行と投稿POSTが404、認証済みの同ticket状態GETが機能することを確認する。
無効化前に受理された処理は完了し得るため、設定反映で既存送信を取り消したとは見なさない。
unknownはDiscord表示と状態GETを照合して手動判断する。

DO、namespace、認証状態、履歴、quota、SESSION_SIGNING_KEY、APP_PASSWORD_HASHを保持する。
削除、初期化、鍵交換、結果不明の自動再送、旧Webhook直送UIへの復帰は行わない。
未設定/falseへの全面停止は状態GETも拒否するため、追加の必要性を確認してから行う。
read-onlyが存在しない旧Worker versionへ単純rollbackすると照会を失うため、まず現在のRCで書き込みだけを止める。
コードrollbackが必要なら保存schemaと署名の互換性を確認して別承認する。
現行deploy/versionを取得できていないため、具体的な旧version IDを推測して記載しない。

## 11. 最終判定と残条件

READY WITH CONDITIONSは移行計画の準備判定。
Stage 1実行前にはCloudflare管理アクセス、既存binding/namespace/migration、Secret名、vars、契約、CPU設定、自動deploy、停止変更権限の確認が必要。
Botの実効role/channel設定を読み取りで確認し、投稿そのものはStage 3へ残す。
今回確認できた公開Workerの401/403/404だけで本番認証成功や投稿flag無効を断定しない。
Step 6Bは未着手。ユーザーの次の指示を待つ。

## 12. 変更ファイルと検証範囲

変更する追跡ファイルは`worker/docs/phase3/STEP6A-RESULTS.md`だけ。
productionコード、テスト、package、設定、Secret、Migrationは変更していない。
今回は公開配信確認とdry-runを実行した。Step 5の113 Node/20ブラウザ等を今回再実行したとは扱わない。
既存ローカルWrangler差分と.bakを保護し、開始前後のSHA256が一致した。

```text
wrangler.jsonc: D4D5326B330B36950FD47320E246E46C9A9A27626055614053A77445B620505F
wrangler.jsonc.bak: 7F28CAB37EACF66ED31162FF08640D74B18878B9B3CFF75EBB278286F925723F
```

## 13. Commit SHAとpush結果

監査文書の初版commit：`349a4f1205837eacc3253eea323e3ce3998e5895`。
`git push origin main`は成功し、`git ls-remote origin refs/heads/main`が同SHAと一致した。
この確定値を記録する文書のみの追加commitのSHAは、自己参照を避けて最終報告へ記載する。
本番Workerの設定変更、デプロイ、Discord実投稿は行っていない。

# Phase 3 Step 1 — Bot API方式・契約確定

Step 3 scope update: see [STEP3-RESULTS.md](STEP3-RESULTS.md). The current user
instruction supersedes earlier Step 3 public-activation statements: posting
handlers remain internal and disconnected; no capability/public write is enabled.

更新日: 2026-10-09（日本時間）。設計基準main: ff63a4a001f3be4c5e5ecf2462b71645b534d8e6。
Production実装基準は1359bb4（ff63a4aは文書のみ）。今回も実装・設定・Secret・migration・本番操作は変更しない。
**運用仕様はユーザー確定。以下のAPI/状態/保存方式はStep 2以降の実装契約として確定する。実装済みという意味ではない。**
[API-CONTRACT.md](API-CONTRACT.md) / [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)。

## ユーザー確定仕様

|項目|確定要件|
|---|---|
|投稿方式・表示|Discord Bot API。Botの名前/アイコン|
|Token・投稿先|既存DISCORD_BOT_TOKEN、固定DISCORD_FORUM_CHANNEL_ID。追加Webhook Secretなし|
|認証/編集|投稿時にログイン。解析/編集/プレビューはログイン不要|
|投稿頻度|全利用者・全セッション合計、任意の連続60秒で10送信attempt以下|
|投稿操作履歴|操作発行から30日間。期限後の古いキーは投稿不可|
|保存失敗|送信開始前の永続保存に失敗したらDiscordへ送らない|
|意図的再投稿|確認画面を経て新しい操作ID|
|結果不明|自動再送禁止、同じIDで再照会|
|障害時|ブラウザ直送fallbackなし。解析/プレビューは使える|
|旧Webhook|Bot API本番動作確認後に削除。今回削除しない|
|Phase 4|別操作/過去イベントとの内容重複検出|

「投稿時ログイン」は解析/プレビューに認証を要求しないこと。既存Phase 2の認証必須tags/session/logoutを非認証公開へ変更しない。
非認証でも8名称の手動選択/プレビューは可能。ID変換・tag制約取得は投稿前login後に行う。
新規の操作発行/状態照会は投稿に付随する保護APIとしてBearer必須。サーバー側に利用者を識別する新しい権限モデルは足さない。

## 1. 現状の実装構成（コードで確認済み）

### Repository全体

|範囲|役割|
|---|---|
|app.js / index.html / styles.css|ブラウザUI・解析・Webhook直送・認証画面|
|worker/src/index.mjs|Workerルーター、AuthState、Discord読み取り、固定分類の診断ログ|
|worker/wrangler.jsonc|既存Worker discord-event-poster-api / AUTH_STATE / AuthState / auth-v1|
|package.json / package-lock.json|noble-hashes 2.4.0、esbuild 0.28.2、Miniflare 5.20261006.1-alpha、Wrangler 4.149.0、Playwright 1.64.0|
|tests-v010.js / tests-acceptance.cjs|解析・通信・状態・保存・秘密非露出のVM試験|
|tests/browser-acceptance.cjs / tests/phase2-browser.cjs|Edge・通信モックによる投稿/認証/タグ連携の画面受入|
|tests/pages-verify.cjs|Pages配信一致・非公開ファイル・表示確認（投稿しない）|
|worker/tests/*.mjs|認証・共有状態・PBKDF2本番制約再現・SQLite workerd試験|
|README.md / ACCEPTANCE.md / worker/*.md|使い方、v0.1受入記録、Phase 2設計・PBKDF2修正手順|
|worker/prepare-secrets.ps1 / .gitignore|非表示入力での初期Secret生成、ローカル秘密ファイル除外|
|_config.yml|Worker・テスト・依存・workをPages公開対象から除外|

ローカル worker/wrangler.jsonc は整形と preview_urls:false がmainとの差分。
worker/wrangler.jsonc.bak は未追跡。どちらも保持する。
tracked設定・ソース・テスト・既存文書を調査し、lockfileは依存メタデータとして確認。node_modules、work、秘密ファイルは調査対象外。
Pages URL/Worker名は依頼とコードで確認。本番稼働版、Secret値、実Discord権限は今回は未確認。
ACCEPTANCE.mdはv0.1.0の過去の受入記録であり、Phase 3/最新本番の証拠ではない。

### フロントエンド

|対象|実装済み|根拠/制限（基準commit）|
|---|---|---|
|入力・解析|【地域】『タイトル』形式で複数イベントを分割。リンク、期間、説明、ハッシュタグ抽出|app.js:16-23。入力内の地域/題一致注意のみ。過去投稿照合、AI、URL本文取得なし|
|編集|地域、題、開始/終了、公式URL、本文、ハッシュタグ|app.js:28,112。イベント件数5件打切りなし|
|タグ|8名称、手動ON/OFF、最大5。ボタン時だけ編集済み題/本文から判定・根拠表示|app.js:8,23-24,119-120。判定は選択状態を置き換える|
|プレビュー|contentFor/threadNameで送信文を生成、escapeHtmlで表示。タグ名表示|app.js:25-29。MarkdownをHTMLに解釈しない|
|Webhook|password入力・表示切替。HTTPSのDiscord公式ホスト/pathだけ許可|app.js:13-15。userinfo/port/query/hash拒否。URLはWorkerへ送らない|
|保存|localStorage key discord-event-poster.webhook、保存ONのみ。変更反映/OFF削除/忘れる/復元|app.js:30-32,113-117。暗号化保管庫ではない|
|投稿|ブラウザがWebhookへPOST、wait=true、content/thread_name/applied_tags/allowed_mentions.parse=[]|app.js:33-103。Worker経由投稿なし|
|検証|題必須、threadName100、content2000、公式URL http/https、5タグ、未設定ID停止|app.js:27,78-81。文字数はUTF-16 length。サーバー投稿検証なし|
|タグ照合|GET tagsをメモリーに保存、名前→ID。タグ付きだけWebhook IDをWorker照合|app.js:24,79,122-156。タグなしはログイン不要|
|送信UI|未送信→送信中→成功/失敗/結果不明。成功リンク、失敗だけ再送|app.js:95-110。成功/不明は通常再送対象外|
|二重実行|state.posting、disabled、順次queue、内容/タグ/endpoint snapshot|app.js:72-103。ページ内限定。再読込/別タブ/別エッジには無効|
|異常系|30秒、5xx、network/CORS、receipt欠落は不明。429最大3再試行、待機60秒上限|app.js:33-70。失敗/不明の区別あり|
|Workerセッション|sessionStorage key discord-event-poster.session、token/expiresAt。期限・401で消去|app.js:122-156。Worker通信15秒timeout。非2xxの詳細分類を捨てる|
|再開|イベント・選択・投稿結果・forumConfigはメモリーだけ|再読込で喪失。Idempotency Keyなし|

### Worker

|公開経路|認証|現在の機能|
|---|---|---|
|POST /api/login|Origin必須、ログイン前|password検証、token/expiresAt|
|GET /api/session|Bearer必須|署名・期限・保存状態確認|
|POST /api/logout|Bearer必須|該当保存セッション削除|
|GET /api/forum/tags|Bearer必須|固定channelタグ、mapping/missing/duplicates/unknown|
|POST /api/forum/webhook-check|Bearer必須|webhookIdのみ。固定channelのwebhooks一覧で所属確認|
|OPTIONS|Origin、許可method/header|GET/POST、Authorization/Content-Typeのみ|

worker/src/index.mjs:73-134がルーター。query付き拒否、未設定503、未知経路/不一致method404。
一時的な /api/diagnostics/discord は1359bb4で撤去済み。現在の公開APIに含めない。

- 認証: PBKDF2-SHA256 600,000回（noble純JS）、16バイトsalt/32バイトdigest、厳格なAPP_PASSWORD_HASH形式。
- 署名: HMAC-SHA256、SESSION_SIGNING_KEY、1時間期限、ランダム32バイトID、id.expires.signature。
- DO: AUTH_STATE / personal-auth-v1の単一オブジェクト、sessions/attempts保存、promise queue直列化。最大20セッション、15分に成功/失敗合わせ5試行、alarm清掃。
- Origin完全一致＋Bearer認証。CORSだけに依存しない。認証失敗時にDiscord情報を返さない。
- env.DISCORD_BOT_TOKEN / env.DISCORD_FORUM_CHANNEL_IDで読取先固定。任意channel入力不可。
- Discord GET共通処理はv10固定ベース、Bot認証、10秒timeout、redirect:manual。呼出側で3xx拒否。POST対応/共通429待機なし。
- tagsはtype15/id一致を検証。8名称完全一致、重複名はmappingから除外、未登録/その他検出。moderated、REQUIRE_TAG、タグ版数は返さず、投稿時再検証なし。
- errors/logsは固定stage、文字パターンで検査したerrorName、任意HTTP statusのみ。生body/message/Secretは出さない。errorNameは固定allowlistではない。
- smallJsonはContent-Typeと4,096バイトstream上限。login/webhook-checkに適用、logout本文は処理しない。サイズ専用413/read期限は未実装。login parseは400、webhook-check parse例外は共通503へ。
- 共有レート制限はログインのみ。tags/所属GETの頻度制限、Discord bucket/global管理、投稿制限なし。
- Secretの名前のみ設定で確認。値は読まない。observability:falseでもconsole.errorコードは存在する。


## 2. 既存設計からの変更

- 固定Webhook推奨を撤回しBot APIに確定。WebhookのSecret移管/所属GET/投稿adaptorは実装対象から外す。
- 投稿表示はBot。既存本文formatter・手動タグ・順次queueは維持。
- 10回/10分＋2秒間隔案を廃止し、全利用者合計10回/60秒のsliding windowに確定。
- 詳細30日＋無期限tombstone案/10,000キー案を廃止。履歴は30日で削除し、署名付き期限キーで古い操作の再受付を防ぐ。
- ブラウザUUIDだけのIdempotency-Keyを、サーバー発行のoperationId＋期限付き署名ticketに変更。追加の準備APIが必要。
- 旧Webhookは本番Bot確認後に削除。UI/保存/直送コードはStep 4で撤去し、実Webhook削除はStep 6だけ。

## 3. Bot API公式仕様と本アプリの契約

|対象|公式仕様の確認結果|本アプリで確定する扱い|
|---|---|---|
|作成|POST /channels/{channel.id}/threads、forum専用形式|固定v10 URLだけ。任意channel不可|
|権限|forum作成にSEND_MESSAGES。CREATE_PUBLIC_THREADSは使用しない|VIEW_CHANNELとSEND_MESSAGESの有効権限を本番Gateで確認。タグ取得成功を投稿確認に転用しない|
|タグ|applied_tags、最大5。moderatedにはMANAGE_THREADS|8名称の固定forum対応を毎attempt検証。required/moderatedを考慮|
|本文/名前|name 1〜100、message.content最大2000 characters|既存互換のUTF-16 code unitsで100/2000。JSON16KiB（公式の25MiBより小さいアプリ独自上限）|
|成功応答|Channel＋nested message。PUBLIC_THREAD|type11/parent_id/guild_id/id/message.id/channel_idを検証、保存して返信|
|メンション|message.allowed_mentionsで制御可能|parse=[]、replied_user=falseをサーバー強制|
|429|Retry-After/retry_after、bucket/global制限|共有cooldown、有効waitの最大値、安全な同キーretryのみ|
|リダイレクト|WorkersのfollowはAuthorizationを別hostへ転送し得る|manual、全3xx拒否。Locationへアクセスしない|

公式のcharactersにはUTF-16/コードポイント等の厳密な単位の明記を確認できなかった。Discordの内部実装単位を推測で確定しない。
本アプリの契約はUTF-16（JS length）に確定する。ASCII/日本語BMPは1、補助平面絵文字は2、結合文字/ZWJの各構成要素も数える。
これは既存UIと同じ保守的な受付範囲。無効surrogate拒否、CRLF→LF正規化後に数え、NFC変換はしない。公式サーバーの最終拒否400は正常処理する。
参考: [Channel](https://docs.discord.com/developers/resources/channel)、[Threads](https://docs.discord.com/developers/topics/threads)、[Message](https://docs.discord.com/developers/resources/message)、[Rate limits](https://docs.discord.com/developers/topics/rate-limits)。

### 作成後の編集・削除（仕様調査のみ）

- スレッドはPATCH/DELETE /channels/{threadId}で管理できる。名前/archived/auto_archive_durationは作成者またはMANAGE_THREADS、locked/slowmode等はMANAGE_THREADS。削除はMANAGE_THREADS。
- Bot自身の初期message.contentはPATCH /channels/{threadId}/messages/{messageId}で編集可能。削除も可能。他者message削除はMANAGE_MESSAGES。locked/archived制約も受ける。
- 編集時にもallowed_mentions指定が必要。他者の本文をBot管理者だから自由に編集できるとはしない。
- これはDiscordの能力説明。Phase 3に公開編集/削除APIを追加せず、unknownの自動削除/再作成や30日経過時のDiscord削除もしない。

## 4. 投稿フローとAPI

~~~mermaid
flowchart LR
  A["非認証の解析・プレビュー"] --> B["投稿確認・ログイン・固定タグID取得"]
  B --> C["操作発行API: UUID + 30日期限ticket / 未開始記録"]
  C --> D["ブラウザで操作情報を永続保存"]
  D --> E["POST /posts: 認証・固定タグ・親forum再検証"]
  E --> F["AUTH_STATE: rate slot + sendingをcommit"]
  F --> G["Worker: 固定forumへBot POST"]
  G --> H["AUTH_STATE: 結果をcommit"]
  H --> I["返信 / 同じIDとticketでGET照会"]
~~~

- POST /api/forum/post-intents: 正規化済みpayloadを受け、未開始記録と署名キーを発行。Discord投稿はしない。
- POST /api/forum/posts: 同payload＋Idempotency-Key（署名ticket）、Bearer、Origin/Host。1操作1スレッド。
- GET /api/forum/posts/{operationId}: 同ticket＋Bearerで状態照会。キー期限が切れたら410。
- 詳細JSON・状態・HTTP/error codeは [API-CONTRACT.md](API-CONTRACT.md)を唯一の契約とする。
- threadName/contentの生成は既存formatterを維持。Workerは地域/日付を再推定しない。プレビュー/送信が同じsnapshot/正規化を使う。
- Bot認証はサーバーだけ。SecretからToken、envからforum ID、固定discord.com/api/v10ベース。クライアントのURL/Token/送信先は受付しない。

## 5. 二重投稿防止・30日保存

### 期限付きキー

DOがUUID v4、issuedAt、expiresAt=issuedAt+2,592,000,000ms、固定principal/target/payloadHashを発行し、not_startedを永続保存してから署名ticketを返す。
ticketは既存SESSION_SIGNING_KEYによるHMAC-SHA256。session署名とは別domain（forum-post-operation:v1）で生成。新Secret/鍵交換不要。
発行日時はサーバー由来でpayloadHashと一緒に署名される。ブラウザの作成日時やUUIDだけから期限を信用しない。
履歴は30日で全状態（unknownも含む）の詳細/キー/hashを削除。無期限tombstoneを残さない。
30日で論理失効、物理削除はalarm/回復時清掃。platform障害中に定刻物理削除まで保証するとは記載しない。
削除後も古いticketのexpiresAtでPOST/GETを410拒否。期限を書き換えると署名不正。発行APIに既存operationIdやcreatedAtを受け取らせない。
同じ古いIDを新規受付するfallbackなし。有効ticketなのにDO記録がない場合も503 STATE_UNAVAILABLEで停止。記録を再作成しない。
署名鍵が交換された場合は旧ticketを安全側に拒否する。GETで結果を回収したい場合も、署名/key保持の保証を別途再設計するまで自動移行しない。

### 保存と競合

AUTH_STATE / AuthState / personal-auth-v1 / auth-v1を維持。新Worker/DO binding/migrationなし。postsキー・共有rate/cooldownを追加する将来設計。
本文/Token/BearerはDOへ保存しない。UUID、hash、期限、state、attempt、quota、receipt IDsだけ。
外部networkはDO queue/transactionの外でWorkerが行う。
transaction内で記録/hash/state/session/期限/target/rateを再読し、reserved→sendingと共有slotを原子的にcommit/awaitしてから1回だけfetch。
保存が失敗すれば送信ゼロ。sendingが保存済みだがfetch前に中断した場合はunknownになることがある（重複回避を優先）。
attempt lease15秒、sending deadline120秒。古いattemptはCAS拒否。sending期限切れをretry許可へ戻さない。
expiresAtまで120秒未満なら新attemptを始めない（409 OPERATION_EXPIRING）。結果commit時もexpiryを再確認し、削除済みrecordを再生しない。
receipt commit後の返信消失はGET/同キーreplayで回収。POST後timeout/5xx/不正JSON/Worker再起動/receipt保存失敗はunknown、自動再送禁止。
同attemptの遅い正当receiptだけunknown→succeeded可。30日後に遅い結果を再保存しない。
alarmはauth清掃を維持し、post期限と協調して設定。リクエスト時にも期限を検証し、清掃遅延で期限後の操作を許可しない。

### 保証境界

DiscordとDOは分散transactionではないため厳密なexactly-once保証はない。
APIのnonce/enforce_nonceをforum作成の保証に転用しない。成功したか分からないケースでは未投稿でもunknownを残し、自動再送より安全を優先。
意図的再投稿はOwnerの確認画面から新しいUUID/ticketを発行。旧unknownは成功/未投稿へ自動変更しない。
Phase 4はこの新しい別操作を含めた内容重複検出を担う。

## 6. 全利用者合計10件／分

- 一つの既存DO、app-wide rateキー。user/session/forumごとに別quotaを作らない。
- sliding window: serverNow−60,000msより後のdispatch予約時刻を残す。10件なら新attemptは429 APP_RATE_LIMITED。
- 算入点はDiscord fetch直前のbeginSend commit。attempt/stateとslotを同一transactionで保存。11並行要求でも10以下。
- Discord拒否/429/結果不明も算入。commit後fetch前crashでもslotを戻さない（保守的な上限）。
- 操作発行、GET、same-key replay、進行中キーの再要求は算入しない。明確な非作成後の新attemptは1件追加。
- Retry-Afterはceil((最古slot+60,000−now)/1000)、1以上。境界ちょうど60秒で古いslotを除く。
- Discord429はDISCORD_RATE_LIMITEDと区別。有効wait最大値をglobal/bucket共有保存し、その時間より早くretryしない。2秒間隔案は撤去。
- DO読取/保存障害は503 STATE_UNAVAILABLE、新規送信ゼロ。インスタンスローカルcounterへのfallbackなし。
- この10件はアプリの上限。Discord固有制限がさらに低い/長い場合は両方を守る。詳細はAPI契約。

## 7. フロントエンド移行

解析/編集/プレビュー/8タグ手動判定/順次queueはログインなしで維持。投稿直前だけログインを促す。
tagIds確定には既存の認証済みtags取得を使う。失われたタグを黙って外さず確認画面へ戻す。
操作情報（UUID、ticket、expiresAt、payloadHash、時刻）をsessionStorageへ保存。本文/Bot Token/Webhook URLは保存しない。
storage利用不可/容量超過の場合はDiscord POST前に停止。履歴保存もサーバーで成功必須。
再読込後は同じID/ticketでGET。入力本文の復元、タブ終了/別端末の操作履歴検索は初期範囲外（サーバー履歴は30日保存）。
not_started/preparing/sending/succeeded/retryable/failed/unknown/expiredの表示を区別。結果不明は確認先行、新キー自動発行禁止。
成功リンクはguild/thread/message IDsから固定Discord URL。Bot表示変更は合意済み。
Webhook入力/保存/参照/直送/自動fallback、frontend webhook-check依存はStep 4で撤去。旧localStorageキーだけを削除し、他のデータに触れない。
旧Worker APIのwebhook-checkは互換撤去後に廃止。旧Discord Webhook自体はStep 6のBot本番受入後にだけ削除。古いPages cacheによる直送が残る期間は完全統制とは扱わない。

## 8. セキュリティ境界

- PBKDF2-SHA256 600,000回、APP_PASSWORD_HASH互換、Bearer署名/期限/失効、共有login試行制限、既存DOを維持。
- 現コードはOrigin完全一致あり、明示Host許可リストなし。「Hostも実装済み」とは記載しない。
- Step 2で新投稿経路にrequest URLのhttps/hostを固定Workerのdiscord-event-poster-api.monma5435.workers.devへ検証。Host/X-Forwarded-Host/クライアントheaderで許可値を上書きしない。ローカルfixtureは固定許可hostで試験。
- CORSにIdempotency-Keyを追加、Bearerなしを認めない。GET status/操作発行も認証。Originを偽装しただけでは投稿不可。
- server-side本文/schema/Unicode/タグ所属/required/moderatedを検証、allowed_mentionsをサーバー固定。
- 権限GETの成功は投稿可能の証明ではない。実際の403は非作成失敗、UIへpermission不足を返す。管理者Botでも任意URL/Discord route/編集削除proxyなし。
- manual＋全3xx拒否を維持。既存Bot Authorizationを固定discord.com以外へ送らない。
- ログは固定stage/errorCode/status、server-generated requestIdのみ。input、hash、操作ticket、Token、URL、Authorization、Cookie、Discord body、例外message/stackを除外。
- 操作ticketは認証tokenの代用ではない。盗まれたticket単体で発行/投稿/状態照会できない。
- 投稿先/署名鍵の変更で旧操作を新規化しない。unknownの自動削除やrepair投稿をしない。

## 9. 実装順序と残課題

Step 1は今回完了。Step 2のBot transport/validationはテスト経路のみ、public送信禁止。
Step 3の永続状態/署名ticket/rateが合格してからpublic POSTへ統合。Step 4 UI撤去、Step 5 E2E、Step 6承認後の本番受入/旧Webhook削除。
実行順・ファイル・事故注入試験は [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)。
未確認: 現BotのSEND_MESSAGES/必要時MANAGE_THREADSの有効権限、本番CPU/通信時間、Discordの文字数内部単位。
これらは実装を止める未決運用仕様ではなく、mock試験/本番Gateの確認項目。Bot権限の検証のために今回は実投稿しない。

## 10. 今回の文書作業の完了条件

3設計文書とREADMEだけを更新。Production code/設定/Secret/依存/テスト/backup不変更。
文書内のWebhook推奨・追加Secret・10/10分・無期限tombstone・未決Owner Gateを撤去し、確定仕様に整合。
現行テスト結果は完了チャットへ（将来のBot実装試験ではない）。SHA/remote一致もチャットへ。
次のユーザー指示までStep 2実装を始めない。

## 公式参照（2026-10-09確認）

[Forum作成/タグ](https://docs.discord.com/developers/resources/channel) /
[Thread権限・編集削除](https://docs.discord.com/developers/topics/threads) /
[Message本文・mentions・編集](https://docs.discord.com/developers/resources/message) /
[429](https://docs.discord.com/developers/topics/rate-limits) /
[Workers redirect](https://developers.cloudflare.com/workers/runtime-apis/request/)

公式の数値・権限説明と、本アプリの署名ticket/30日/UTF-16/16KiB/10件sliding windowは別の仕様。

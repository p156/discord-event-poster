# Phase 3 調査・設計（提案、実装前）

調査日: 2026-10-09（日本時間）。
基準: main / 1359bb48178589e08afb383f64915af7dc5fa7d4。
新API、投稿方式、記録形式、数値は未承認の提案。現行仕様と区別する。
API詳細は [API-CONTRACT.md](API-CONTRACT.md)、段階計画は [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)。

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

## 2. Phase 3で不足している機能

固定投稿先のサーバー送信、本文/タグ再検証、投稿権限判定、永続操作記録、再照会、共有投稿頻度/429管理、切替UIが必要。
現UIの成功/失敗/不明は利用できるが、workerApiは非2xxを一律throwするため専用adaptorが必要。
Idempotency Keyだけ、ブラウザロックだけでは外部投稿の二重作成を防げない。

## 3. Webhook方式とBot API方式の比較

|比較|WorkerからWebhook|WorkerからBot|
|---|---|---|
|forum/thread/tag|thread_name/applied_tags、wait=true|固定channels/{ID}/threadsへname/message/applied_tags|
|権限|投稿はWebhook token。作成/管理は別途MANAGE_WEBHOOKS。タグ読取Botは現状維持|VIEW_CHANNEL・SEND_MESSAGESを想定。forum作成はCREATE_PUBLIC_THREADS不要。moderatedタグはMANAGE_THREADS、後続messageはSEND_MESSAGES_IN_THREADS|
|既存互換|Webhook投稿者・アイコン・payloadを保ちやすい|Bot名義へ変わる。初期message/receipt形式変更|
|Secret|追加提案DISCORD_POST_WEBHOOK_URL、既存Bot Tokenは読取|既存Bot Tokenのみ。ただし書込にも使用|
|応答/エラー|Message receiptを正規化|Channel＋初期Message receiptを正規化|
|難易度|小。contentFor/threadName/mentions維持|中。権限・表示・応答受入が必要|
|運用|旧URL保持者の迂回を閉じるには失効/入替|旧Webhookの失効は別途必要|
|二重防止|DO記録必要|同じく必要。nonceでforum作成exactly-onceを保証しない|

根拠: [Webhook](https://docs.discord.com/developers/resources/webhook)、[Forum/タグ](https://docs.discord.com/developers/resources/channel)、[Threads権限](https://docs.discord.com/developers/topics/threads)。
Webhookでmoderatedタグを許可できるかは実環境で確認し、未確認ならそのタグを拒否する。

## 4. 推奨方式（未確定）

固定WebhookをWorker Secretへ移管する案を推奨。既存Webhookの互換性を優先する。
Bot APIはSecret追加不要の利点があるが、表示/権限/receipt変更を伴う。APIのtransportは非公開にして将来切替を可能にする。

DISCORD_POST_WEBHOOK_URLは今回登録しない。公開APIでURLを受付しない。
SecretだけからHTTPS discord.com/api/v10/webhooks/{ID}/{token}を構成し、userinfo/port/query/hashを拒否。
既存の/api/webhooks/{ID}/{token}形式も管理者が登録可能とし、サーバー側でv10へ正規化する。ホストはdiscord.comだけ。その他の旧ホスト/版の移行は管理者が確認する。
送信前に固定forumのtype/guild/IDをBot GETで確認し、固定WebhookのGET-with-tokenでtype1/id/channel_id/guild_idを照合する。
GET-with-tokenはBotのMANAGE_WEBHOOKSなしで照合可能。受取オブジェクトのtoken/urlはログ/返信に使わない。
不一致、削除、読取失敗、3xxは送信前に停止。初期は照合をキャッシュしない。外部設定変更によるTOCTOUはゼロにはできない。
Secret移管/旧Webhook入替は管理者の作業。公開APIにWebhook作成や任意proxyを足さない。

~~~mermaid
flowchart LR
  A["入力・解析・最終確認"] --> B["1イベント + 操作キー"]
  B --> C["Worker: Origin / Bearer / 本文・タグ・投稿先検証"]
  C --> D["AUTH_STATE: 予約 / 制限 / sending保存"]
  D --> E["Worker: 固定WebhookへPOST"]
  E --> F["AUTH_STATE: receipt / rejected / unknown保存"]
  F --> G["画面: 結果表示・同じキーで照会"]
~~~

## 5. API契約案

[API-CONTRACT.md](API-CONTRACT.md)にPOST /api/forum/posts、追加GET /api/forum/posts/{operationId}を定義。
ブラウザは最終threadName/content/tagIdsを送る。URL/Token/channel/guild/transport/allowed_mentionsの指定は禁止。
サーバーは再解析せず、長さ・構造・固定タグ所属を再検証する。
previewとPOSTは同じimmutable snapshotから作り、移管で本文を勝手に書き換えない。

## 6. 二重投稿防止案

### 保証範囲

UUID v4（crypto.randomUUID）を認証Ownerの1操作に固定し、再読込/再ログイン/別インスタンスで再利用する。
principalはサーバー固定personal-owner-v1。session ID、event-1、タイトルを操作scopeにしない。
canonical payloadHashはversion/threadName/content/sorted tagIdsから作る。同キー異payloadは409。
target fingerprintを別保存し、retry時のforum/Webhook変更を拒否。終端結果は旧投稿先でも読取可。

送信済みか不明なら再POSTしない。DiscordとDOの間に分散transactionはない。
[Message仕様](https://docs.discord.com/developers/resources/message)のnonce/enforce_nonceをWebhook実行/Forum作成の保証に転用しない。
同じ操作の並行送信を制限するが、外部障害時のexactly-onceは保証しない。未投稿でもunknownに残ることがある。

### 状態と障害

|状態|意味|追加送信|
|---|---|---|
|reserved|受付済み未送信、15秒attempt lease|有効な1attemptだけbeginSend可能|
|sending|送信前の永続記録済み|同キー要求202。別attempt禁止|
|succeeded|receipt保存済み|禁止、保存結果返却|
|retryable|未作成確定（明確な429等）|nextAllowedAt以降、同キー同payloadのみ|
|failed|明確な非作成の終端拒否|自動再送なし。修正は新規操作|
|unknown|送信開始後のtimeout/5xx/不正receipt/中断|禁止、手動確認|
|retired|詳細期限切れのcompact tombstone|旧キーの新規受付禁止|

reserved→sendingを永続commit/awaitしてからfetch開始。外部fetchをstorage transaction内で実行しない。
reserved期限切れはCASで古いsend権限を無効化してから再予約。古いattemptのbeginSendは拒否、fetch禁止。
sendingが120秒超ならGET/受付/清掃でunknown。lease切れを再送許可にしない。
同じattemptの遅い正当receiptだけunknown→succeeded可。他attemptや後続失敗で成功を上書きしない。
receipt保存後の応答消失はGET/同キーPOSTで成功回収。Discord成功後DO保存失敗はunknownで再送禁止。
auth/validation/配置・タグGETの失敗は送信前なので非作成と確定。
途中ログアウトは既に送信したDiscord要求を取り消す保証なし。次attempt/照会は再認証必須。

### DO/保存案

AUTH_STATE / AuthState / personal-auth-v1、sessions/attempts、auth-v1を維持。初期推奨案に新binding/new Worker/DO migration不要。
posts:{UUID}、posts:cooldown、posts:quotaを追加。予約・attempt CAS・頻度をstorage.transactionで原子的に更新。
既存promise queueは短い内部state操作だけ。ネットワークは外側Workerで行い、10秒待機中にauthを塞がない。
DO actionはpublic routerからのみ明示allowlist。beginSend内でもsession/attempt/target/cooldownを再検証。

payloadHash、target fingerprint、state、attemptId/count、timestamps、固定error、receipt IDsを保存。
本文、Webhook token、Bearerは保存しない。詳細30日、以後key/hash/終端状態のみtombstoneを維持する案。unknownは未解決として保管。
セッション期限でpost記録を消さない。tombstone削除後の同キー再受付は危険なため初期案は期限なし。10,000キーで新規受付停止/運用判断とする案。
保存期間/容量はOwner判断。TTLで完全削除するなら期限付き署名ticket等の追加設計が必要。
alarmは既存auth清掃とpost清掃を共存。unknownをalarmで再送しない。
DOにはalarmが1つなので、auth/postの次回清掃時刻を協調させ、loginのsetAlarmでpost清掃を意図せず延期しない。期限判定はGET/受付時にも行いalarm実行だけに依存しない。

## 7. セキュリティ設計案

- 認証/PBKDF2/署名鍵/失効/ログイン制限を維持。全投稿・照会ログイン必須化は承認事項。
- Origin＋Bearer＋server principal。CORSにIdempotency-Keyを追加。Origin偽装だけでは投稿不可。
- POSTは16KiB stream上限・5秒読取期限・JSON object・unknown field拒否。無効UTF-8/孤立surrogate/禁止control/重複memberは契約に沿い試験。
- 宛先はenvのみ。リンクは本文データ、Workerはfetchしない。Markdownは許可、画面はtextContent/escapeHtml。
- allowed_mentions.parse=[]を強制。任意mentions、embeds/files/TTS/username変更を受付しない。
- tagIdsは毎attemptで固定forumと8名称の一対一mappingから再検証。消滅/重複/別forum/6タグを拒否、REQUIRE_TAG/moderatedを加味。
- Administrator Botでもroute固定。Webhook POSTにBot Authorizationを付けない。manual＋3xx拒否を維持、Locationへ送らない。
- 推奨: dispatch10回/10分＋2秒間隔、読取60回/分。既存結果回収はdispatch quotaを消費しない。ログイン制限とは分離。
- Discord429の有効headers/bodyから最大waitを共有保存。Bot GETとWebhook tokenのbucket/global scopeを分ける。
- 旧URL保持者はSecret移管だけでは排除できない。最終cutoverで旧Webhook失効/入替をOwner承認事項にする。
- ログは固定stage/errorCode/status、server-generated requestId/attempt番号のみ。操作キー/本文/hash/URL/Authorization/Cookie/生body/exception message・stackを出さない。errorNameも固定allowlistへ。
- 自動traceに秘密URLが残る可能性は運用確認。生requestやcatch前例外をdebug/tailへ出す実装を足さない。

## 8. UI変更方針案

入力/解析/タグ/自動判定/preview/1イベント1スレッド/順次queueを維持。
送信確定前にsnapshot/UUIDを作りsessionStorageへoperationId/最小payloadHash/時刻だけ保存。本文/Secretは保存しない。
fetch前にID保存が失敗したら投稿停止（再読込後の照会先を失うため）。Owner確認事項。
再読込では保存IDで状態照会し、本文なしでも結果を回収する。
再読込後の題/本文/タグ編集内容は復元しない。結果一覧は操作時刻/状態/Discordリンクを表示する。タブ終了でsessionStorageが消えた場合や別端末への自動復元は初期案の範囲外。同一内容を新キーで再入力した場合の検出はPhase 4の責務。

|状況|表示・操作|
|---|---|
|認証待ち/期限切れ|解析・preview可。投稿停止。再ログインして同ID照会|
|準備/送信中/202|編集・解析・選択・投稿lock、待機表示、GET照会|
|succeeded|固定Discordリンク、再送不可|
|failed|固定日本語説明。修正は新snapshot/key＋明示確認|
|retryable|wait/残attempt、同payload/keyで再試行|
|通信断|結果確認中。新キーを作らずGET、HTTP例外だけで投稿有無を決めない|
|unknown|投稿済みの可能性警告、Discord確認、自動再送なし|
|retired|詳細期限切れ、旧キー再送不可、forum手動確認|
|Worker利用不可|投稿停止、編集/解析/preview維持。直送へ自動fallbackしない|

現retry-failedをsame-key retryableと修正が必要なfailedに分ける。
タグ未取得でもタグなしは検証可能だがauth必須。REQUIRE_TAGなら拒否。
成功リンクは/channels/@me/から/channels/{guildId}/{threadId}/{messageId}へ。
意図的再投稿は別UUID＋明示確認。未解決unknownがある場合は手動確認を先行し、新キー自動生成で回避しない。

移行中の新経路は明示feature gate。入力URLをServer Secretへ自動登録しない。
切替後Webhook入力/表示/remember/forget、直送、webhook-check依存を撤去する案。
localStorage旧キーは自動読取/送信しない。切替時にそのキーだけの削除を案内。他サイトデータを消さない。
新旧両経路に同じ操作を送らない。旧URL有効/古いPagesキャッシュの期間は完全な投稿権限統制にならない。

## 9. Phase 4との責務分担

Phase 3は1操作の配信事故による二重作成防止と結果保存。
Phase 4は別UUID/別入力/既存Discordスレッドと同じイベントかの検出。
payloadHashは同キー整合性だけ。内容一致による別キー自動拒否なし。
入力内の地域/題一致注意は維持。既存スレッド探索、意味判定、URL本文取得、AIは今回/Phase 3案に含めない。
将来の類似判定でunknownを自動的に成功/未投稿に変更しない。

## 10. Step別計画

[IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)の6 Step。
adaptor単体（Step 2）と永続二重防止（Step 3）を揃えるまでpublic投稿を有効にしない。
Step 6の本番投稿/Secret移管・失効/デプロイは別の明示承認。

## 11. 未確定・Owner判断

|項目|推奨|未確定の理由|
|---|---|---|
|方式|固定WebhookのWorker移管|Bot表示/Secret追加の比較|
|表示・切替|初期は既存表示、最終旧Webhook失効/入替|旧URL保持者の迂回を閉じる外部作業|
|auth|全投稿/照会ログイン必須、障害時previewのみ|現状タグなし非認証投稿が終了|
|頻度|dispatch10/10分＋2秒、読取60/分|実際の運用量・Discord制限|
|記録|詳細30日、tombstone期限なし、10,000キー上限|費用/長期保証/プライバシー|
|storage不可|操作IDが保存できなければ投稿停止|プライベートモード等の扱い|
|タグ|8名称のみ、moderated未確認は停止、required反映|実forum権限の確認|
|再投稿|明示確認で別操作可、unknownは確認先行|重複を完全禁止する用途か|
|本番受入|Owner許可の1件、異常系は先にモック|外部の実投稿の許可|

回答なしでも今回の調査・文書作成は完了可能。実装開始のStep 1 Gateでは判断を記録する。

## 12. 文書変更・検証

追加3件: DESIGN.md / API-CONTRACT.md / IMPLEMENTATION-PLAN.md。README.mdへ案内だけ追記。
基準コードnpm testは36件PASS（旧33＋後続diagnostic/redirect3）、parser assertionsもPASS。
現行Edge受入14項目、Phase 2画面連携、PBKDF2上限fixture付きworkerd/SQLiteも今回再実行してPASS。すべてモック/ローカル範囲であり本番投稿はゼロ。
state crash matrix/API error matrix/Step Gateをレビュー。Phase 3実装の試験PASSという意味ではない。
Production code/設定/依存/テスト変更なし。アプリ・Worker・ローカル設定/backupのSHA-256前後一致を確認。
本番アクセス/デプロイ/Secret操作/DO migrationを行わない。ネットワークはGitHubと資料調査のみ。

## 13. Commit・push

この3文書とREADMEのみcommit。SHAとremote一致は完了チャットに記載。自己参照SHAを文書へ埋め込まない。

## 参照（2026-10-09確認）

- [基準コード](https://github.com/p156/discord-event-poster/tree/1359bb48178589e08afb383f64915af7dc5fa7d4)
- [Webhook](https://docs.discord.com/developers/resources/webhook)
- [Channel/Forum](https://docs.discord.com/developers/resources/channel)
- [Threads](https://docs.discord.com/developers/topics/threads)
- [Rate limits](https://docs.discord.com/developers/topics/rate-limits)
- [Message/nonce](https://docs.discord.com/developers/resources/message)
- [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

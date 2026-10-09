# Phase 3 投稿API契約案 v1（未確定・未実装）

基準コード: 1359bb4。採否は [DESIGN.md](DESIGN.md) §11、実装Gateは [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)。
この契約は現在のWorkerが提供しているAPIではない。1操作＝1イベント＝1スレッド。
数値は推奨初期値。transportはサーバー設定で固定し公開しない。

## 1. エンドポイント

|method/path|用途|条件|
|---|---|---|
|POST /api/forum/posts|新規操作の受付、または同キーの結果回収/安全な再試行|Origin＋Bearer＋Idempotency-Key|
|GET /api/forum/posts/{operationId}|再読込/通信断後の状態照会|Origin＋Bearer|
|OPTIONS 同経路|preflight|Origin一致、GET/POST、許可headerだけ|

baseは既存Worker。任意path/target/queryは拒否。
login/session/logout/tagsは維持。webhook-checkは旧UI撤去後に廃止候補。
GETのIDとPOSTのキーは同じUUID。batch API、任意channel、任意Webhook、添付、編集/削除APIは今回の案に含めない。

## 2. リクエスト

~~~http
POST /api/forum/posts
Origin: <登録済みPages origin>
Authorization: Bearer <既存セッション>
Content-Type: application/json
Idempotency-Key: 123e4567-e89b-42d3-a456-426614174000
~~~

~~~json
{
  "apiVersion": 1,
  "threadName": "【東京】イベントタイトル",
  "content": "📍 **開催地域：東京**\n\n📅 **開催期間：2026/10/23〜2026/11/29**\n\nイベント説明\n\n🔗 **公式サイト**\nhttps://example.com/\n\n#謎解き",
  "tagIds": ["100000000000000001"]
}
~~~

例のUUID/ID/本文は架空。Bearer/Secret値は文書へ記載しない。

|項目|必須|検証/正規化|
|---|---|---|
|Idempotency-Key|yes|UUID v4のcanonical lowercase、36文字。暗号学的乱数で1操作に1回生成。別sessionでも同じOwner scope|
|apiVersion|yes|整数1のみ|
|threadName|yes|string、CRLF→LF後、前後trim。UTF-16 code unitsで1〜100。改行、NUL、禁止control、孤立surrogate拒否|
|content|yes|string、CRLF→LF統一。空白だけ不可。UTF-16 code unitsで1〜2000、trimで本文の空白を勝手に変更しない。NUL、孤立surrogate、tab/LF以外のcontrol拒否|
|tagIds|no|省略は[]。array<string>、0〜5、重複拒否、数字のみ1〜20桁・非zero・64bit範囲。サーバーの固定forumで再検証|

ブラウザは最終snapshotでthreadName/contentを作る。Workerは地域・日付を再推定しない。
入力フォームの公式URL検証は継続するが、投稿APIではURLはcontent中の文字列にすぎない。Workerは取得も宛先解決もしない。
本文のMarkdown、通常URL、ハッシュタグを許可。メンション通知はサーバー側で止める。HTMLとしてUIへ挿入しない。

request bodyは16,384 UTF-8バイト。Content-Length値だけに依存せずstreamで制限、読取5秒、Content-Encoding圧縮受付なし。
JSON rootはobject、field allowlistのみ。tagIds以外のarray/object、null、数値代入、過深nestingを拒否。
重複JSON memberは400。名前のescapeを復号した上で同じmemberを検出できるparserをStep 2の技術選択として用意する。単なるJSON.parseだけで重複拒否を実装したと扱わない。
無効UTF-8はfatal decodeで400。本文サイズは413、読取期限408、Content-Type違い415。
現smallJsonの4KiBを無条件に全APIへ拡張しない。login/webhook-checkの既存制限を維持し、新投稿parserに16KiBを指定する。

禁止field例: webhookUrl, discordUrl, forumId, channelId, guildId, token, transport, allowed_mentions, username, avatar_url, embeds, files, attachments, tts, flags, thread_id, nonce, enforce_nonce。
クライアント指定requestId/actor/priority/adminも受付しない。

## 3. 固定タグ/投稿先の検証

毎外部POST attempt前に認証済みWorkerが以下を確認する。UIが取得したmappingは認証・権限証明ではない。

1. env.DISCORD_FORUM_CHANNEL_IDを数字として検証、Bot GETのid/type15/guild_idを確認。
2. available_tagsから8名称の完全一致を作り、欠落/重複名/不正IDを検出。
3. 選択IDがこの一対一対応に属することを確認。その他タグ・他forum・消滅ID・同ID複数名称は拒否。
4. 選択していない名称の欠落があっても、有効な選択の投稿は可能。選択名の重複・対応不明は拒否。
5. REQUIRE_TAGのforumでは[]を422。moderatedタグは実投稿資格確認済みのものだけ許可。未確認なら拒否。
6. 固定Webhook Secretのendpointを正規化し、GET-with-tokenのtype/id/channel_id/guild_idを固定forumと照合。
7. attempt予約時のdestination fingerprintと現在の固定先が変わっていればretryを409で止める。

GET tagsへconstraints:{maxTags:5, requireTag:boolean}、tagsのmoderated/selectableを追加する案。
id/name/mapping/missing/duplicates/unknownは互換維持。制約APIが返らない旧Workerでは書込開始せずcapability不足表示。
タグ取得失敗時にタグを黙って外してPOSTしない。POSTはGET検証を共有し、一時的なDiscord GET失敗は送信前503（safeToRetry=true）。

## 4. Discord payload/receipt変換

### 推奨Webhook

宛先はSecretから構成したdiscord.comの固定v10 webhook endpointに、サーバーだけがwait=trueを追加。
Secret入力は/api/webhooksと/api/v10/webhooksだけ許可しv10へ正規化。legacyホストや別API版を自動許可しない。
thread_idは設定しない。Bot Authorizationは付けない。

~~~json
{
  "thread_name": "<検証済みthreadName>",
  "content": "<検証済みcontent>",
  "applied_tags": ["<固定forumの検証済みID>"],
  "allowed_mentions": { "parse": [] }
}
~~~

ゼロタグはapplied_tagsを省略または[]で統一（canonical hashは[]）。初期案は[]。
responseのid→messageId、channel_id→threadId、GET forumのguild_id→guildId。forumIdはenv由来。
IDsを数字/範囲で検証しguild_idが存在する場合は固定guildとの一致を確認。receipt欠落/解析不能はunknown。
replayでは保存receiptのguild/forum/targetを使い、現在のenv値で過去のリンクを書き換えない。
成功リンクは固定https://discord.com/channels/{guildId}/{threadId}/{messageId}を組み立てる。任意応答URLを返さない。

### 代替Bot（採用判断が必要）

固定POST /api/v10/channels/{env forumId}/threadsへ次を変換。

~~~json
{
  "name": "<threadName>",
  "applied_tags": ["<ID>"],
  "message": {
    "content": "<content>",
    "allowed_mentions": { "parse": [] }
  }
}
~~~

Channel.id→threadId、nested message.id→messageId。表示はBot名義へ変わる。
message APIのnonce/enforce_nonceをここに追加しない（forum作成契約に同じ保証はない）。
成功receiptを保存する必要とunknown方針は同じ。

仕様根拠: [Webhook](https://docs.discord.com/developers/resources/webhook)、[Channel](https://docs.discord.com/developers/resources/channel)。
外部fetchはmanual、3xx拒否、fetch＋応答本文読取全体で10秒deadline。response.jsonだけ無制限に待たない。
成功応答の読取サイズも64KiB上限案。超過/timeoutは送信後unknown。既存GETの応答サイズ改善は投稿に必要な対象から段階的に行う。

## 5. 共通レスポンス

~~~json
{
  "apiVersion": 1,
  "requestId": "server-generated-uuid",
  "operationId": "123e4567-e89b-42d3-a456-426614174000",
  "status": "succeeded",
  "replayed": false,
  "attempt": 1,
  "safeToRetry": false,
  "retryAfterSeconds": null,
  "error": null,
  "result": {
    "guildId": "100000000000000002",
    "forumId": "100000000000000003",
    "threadId": "100000000000000004",
    "messageId": "100000000000000005",
    "url": "https://discord.com/channels/100000000000000002/100000000000000004/100000000000000005"
  }
}
~~~

status: not_accepted / reserved / sending / succeeded / retryable / failed / unknown / retired。
not_acceptedは保存前のレスポンス状態でDOのpost状態ではない。
operationIdは検証/権限失敗でnull可。requestIdはサーバー生成、秘密の操作キーをログIDに使わない。
replayedはこの要求による新しい外部POSTなしで保存結果を返した場合true。attemptはDiscord write attempt数、受付前0。
safeToRetryは「同じキー・同じpayloadで新規attemptを始めても二重作成にならない」という限定の意味。GET照会可否ではない。
pending/unknown/succeeded/retiredでfalse。retryableはnextAllowedAt後だけ。not_acceptedの非作成が確定した場合true（入力修正/再認証の要否はerror code）。
failedは終端false。入力を修正して新規操作を始めるかは別のOwner操作。unknownで新キーを自動生成しない。

error object例:

~~~json
{
  "code": "OUTCOME_UNKNOWN",
  "message": "投稿された可能性があります。Discordで確認してください。",
  "fields": []
}
~~~

fieldsは固定allowlistのfield名のみ。値、Secret、生Discord body、例外messageは返さない。
unknownはresult:null、safeToRetry:false。retryableはerror.code=RATE_LIMITED、retryAfterSeconds正値。
HTTPステータスだけで送信済みか判定しない。ブラウザの接続失敗にはこのJSONすらないのでGETで照会する。

## 6. HTTPステータス/状態

|HTTP|条件|状態/送信可能性|
|---|---|---|
|201|新attempt成功＋receipt永続化済み|succeeded、再送禁止|
|200|同キー成功replay、またはGET既存操作|保存状態、外部POSTなし|
|202|同キーがreserved/sendingで進行中|safeToRetry=false、GET案内|
|400|構文/未知field/不正UUID/無効UTF-8|not_accepted、非作成|
|401|sessionなし/期限切れ/失効|新attemptなし。既存進行操作の有無は漏らさない|
|403|Origin不一致/Owner権限なし|新attemptなし|
|404|GET操作不存在/未知route|同キー同payloadで再受付可。先行POSTのpreflightが進行中の可能性はある|
|405|新経路のmethod不一致|Allow header。旧APIの404契約は別|
|408|本文読取5秒timeout|not_accepted、非作成|
|409|KEY_PAYLOAD_CONFLICT / DESTINATION_CHANGED|キーを別内容/別投稿先の新規操作に使わない|
|410|詳細期限切れtombstone|retired、旧キー再受付不可|
|413 / 415|16KiB超過/Content-Type・encoding不適合|not_accepted、非作成|
|422|文字数/タグ/required/moderated/投稿先配置不一致|送信前not_accepted、固定field error|
|429|アプリ頻度、または明確なDiscord429|not_accepted またはretryable、共有wait|
|502|Discord送信拒否/receipt不正|failed またはunknown、error code必須|
|503|設定/DO/上流GET障害、送信後中断|not_accepted またはunknown、必ず区別|

GET sending/reservedはHTTP200＋stateで返す（202はPOST再要求）。
認証403はCORS許可headerを返さず、通常レスポンスはno-store/Vary:Origin/X-Content-Type-Options。
POST202/429はRetry-Afterを返し、Locationは相対status APIのみ。CORS expose headersはRetry-After/Location、追加案。
APIが停止/DBが読めない時のGET503を404や非作成証明として扱わない。
同キーterminal failedは保存されたcode/HTTP分類を再返却し、新規外部POSTなし。

### Discord非成功分類

|上流結果|投稿状態|処理|
|---|---|---|
|400/401/403/404の明確な拒否|failed|invalid payload / posting credential / permission / destination unavailableの固定code。Bot401とユーザーsession401を混同しない|
|完全に受信した429|retryable|非作成。wait記録後に同キー再試行可|
|3xx|unknown（write経路）|転送しない。3xxだけで外部副作用なしを保証しない。GET preflightの3xxは非作成|
|5xx/network/timeout/connection reset|unknown|POSTが成功した可能性。自動再送なし|
|2xxだがid/channel_id欠落、invalid JSON、read timeout|unknown|receipt検証失敗、204も成功扱いしない|
|成功後DOへの保存失敗|unknown、または記録上sending|GETで残状態確認。新attempt禁止|

## 7. Idempotency処理手順

GET404は先行POSTが今後受付する可能性を消す証明ではなく、同キー同payloadの安全な再受付だけを許す。

1. Origin、session、header/body、サイズ、schemaを検証。固定Ownerをserverから取得。
2. 同キー記録を先に照会。同hash terminalはreplay、pendingは202、unknownはunknown返却、異hash409。失敗やexpired記録を未送信へ戻さない。
3. 初回/許可retryだけ、fixed forum・Webhook・タグをGET検証。
4. AUTH_STATEのtransaction内で同キー記録/hash/stateを再読し、先行requestが既に予約/送信中なら新規挿入しない。quota/cooldown/capacity/sessionを再確認し、未受付または許可retryだけreservedを保存、attempt leaseを発行する。手順2の読取だけで排他を済ませたと扱わない。
5. beginSendのCASが成功しsending commit済みであることをawait。期限/古いattemptを拒否し、その場合fetchしない。
6. 外側Workerが1回だけ外部POST。重いnetworkをDO promise queue内に置かない。
7. 同attemptのみ結果を記録。receipt commitをawaitして201。失敗persist/応答不能は結果不明に寄せる。
8. browserは同キーを保存。lost responseはGETで回収。Worker statusが不明なら新キー/直送fallbackしない。

payloadHashは固定順JSONのSHA256、tagIdsはsort。本文は上記正規化済み文字列。
target fingerprint（forumId、transport、webhookId）は別管理。Webhook token/署名鍵をhash入力へ含めず、tokenを消したfingerprintだけ保管する。
記録scopeは固定Owner＋UUIDで、session再発行でも同じrecord。方式変更時にscopeを変えて旧UUIDを新規扱いしない。

並行初回、reservation expiry、sending前crash、送信後crash、receipt commit前後のcrash、複数session、DO再作成を必須試験にする。
詳細30日、tombstone期限なし、10,000キー停止案。削除後の古いキー再送を許すTTL設計は別途承認/契約変更。
tombstoneはhash/stateを維持し、同キー異payloadには409、same payloadには410。unknownは自動retireしない。

## 8. 429/投稿頻度案

dispatch quota: Owner/固定forumの10回/10分、POST間隔2秒。各外部write attemptを数える（429拒否も含む）。
POSTの同キーreplay、GET statusはdispatch枠を消費せず読取枠を消費。
読取quota: authenticated Owner 60回/分、同一pendingのpollは2秒から最大10秒にbackoff。
tags/照合GETのrate情報も共有。ただし上流Bot tokenとWebhook tokenのglobal/bucketを混同しない。現在のBot利用が本アプリ外にもあるならAPI429を最終権威とする。

完全に受信したDiscord429はRetry-After/retry_after/X-RateLimit-Reset-Afterの有効値から最大wait（秒、finite positive）＋小さいjitterを採用。
globalフラグ・bucket/scopeからcooldownを共有保存。過大waitを60秒へ切り縮めない。
有効wait欠落/JSON不正なら自動retry停止。非作成はHTTP429から判別できるので、固定の保守的なcooldownを置きmanual待機（初期案60秒）とする。Owner承認の数値。
同キーattemptは初回＋3retry最大4。wait60秒以下でもWorkerをsleepさせず429を返してUIが待機。60秒超もnextAllowedAtは正しく保存し、manual再開案内。
429以外の不明な通信失敗をこの再試行ループに入れない。
アプリquotaとDiscord quotaは別。アプリ10/10分はDiscord制限の代用ではない。

## 9. 現UIとの対応・移行

contentFor/threadName/previewはそのまま最終文字列生成に使う。解析rawや判定根拠をAPIへ送らない。
selectedTags→tagIdsの表示mappingは維持、サーバーで再検証。対応消失時にタグなしへ変換しない。
postOneをWorker専用adaptorへ。今のworkerApiの非2xx一律throwを使うとunknown/retryable/failedを失うため直接再利用しない。
queue順次・lock・confirmは維持。操作IDをfetch前にsessionStorageへ保存し、再読込では本文なしでGET。
非認証タグなし投稿、直送fallback、成功receiptの@meリンクは最終cutoverで変更する提案。
旧URLのlocalStorage保存/入力削除は別Step。旧Secret/URLの移管・失効は自動で行わない。

## 10. 未確定項目

方式、追加Secret/旧Webhook失効、全投稿auth必須、quota、保管/tombstone上限、storage不可時停止、moderated資格、intentional repostをStep 1で確定する。
重複JSON member拒否parser、result polling/capabilityの実装配置は実装担当の技術選択。契約の曖昧さとしてOwnerへ委ねない。
エラー/状態はこの案を基準にテストを先行し、productionへ仮APIを追加してから決めない。

## 参照

- [Rate limits](https://docs.discord.com/developers/topics/rate-limits)
- [Webhook](https://docs.discord.com/developers/resources/webhook)
- [Forum thread](https://docs.discord.com/developers/resources/channel)
- [Message nonce](https://docs.discord.com/developers/resources/message)
- [DO storage transaction](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

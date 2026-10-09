# Phase 3 Step 1 — Bot投稿API契約 v1（確定・未実装）

対象main: ff63a4a。ユーザー確定仕様を [DESIGN.md](DESIGN.md) に記録。
ここで「確定」は次Stepの実装契約であり現在の公開APIではない。1操作＝1イベント＝1スレッド。
認証/Origin/固定先を維持し、新投稿経路に明示Host検証を加える。期限付き操作キーで30日後の再送を防ぐ。

## 1. 公開API

|method/path|目的|認証/キー|
|---|---|---|
|POST /api/forum/post-intents|未開始操作を永続化しUUID/署名ticket発行。Discord投稿なし|Origin/Host＋Bearer|
|POST /api/forum/posts|同操作の初回送信/安全なretry/結果回収|Origin/Host＋Bearer＋Idempotency-Key(ticket)|
|GET /api/forum/posts/{operationId}|再読込後の照会|Origin/Host＋Bearer＋同ticket|
|OPTIONS|preflight|固定Origin/Host、許可method/headerのみ|

操作キー発行API追加は30日保存＋古いキー拒否を満たす技術上の確定仕様。UUIDだけの受付方式は撤回する。
Idempotency-KeyはUUIDではなく署名ticket。operationIdはticket内のUUIDで、GET pathと一致必須。
既存login/session/logout/tagsは維持。解析/プレビューにはlogin不要。投稿の発行/送信/照会は保護する。
任意route/query、投稿先ID/URL/Token、batch、編集削除、旧Webhookへのproxyは受付しない。

## 2. payload（操作発行と投稿で同じJSON）

~~~json
{
  "apiVersion": 1,
  "threadName": "【東京】イベントタイトル",
  "content": "📍 **開催地域：東京**\n\n📅 **開催期間：2026/10/23〜2026/11/29**\n\nイベント説明\n\nhttps://example.com/\n\n#謎解き",
  "tagIds": ["100000000000000001"]
}
~~~

|field|必須|契約|
|---|---|---|
|apiVersion|yes|整数1|
|threadName|yes|string、改行統一後trim、1〜100 UTF-16 code units、改行/禁止control/孤立surrogate不可|
|content|yes|string、CRLF/CR→LF、空白だけ不可、1〜2000 UTF-16 code units、本文の前後空白は変更しない|
|tagIds|no|省略=[]。array<string>、0〜5、重複なし、nonzero64bit decimal snowflake、8名称に対応する固定forumのID|

原子化/署名hash前に、全API/ブラウザで同じ正規化を使う。NFC変換なし、UUID/名前を推測生成しない。
contentのtab/LFを許可し、他C0/DEL controlと孤立surrogateを拒否。titleはtab/LFも拒否。
JSON root object、未知field/重複member/過深構造/null/型違いを拒否。escaped member名も復号して重複判定。
許可外: operationId, issuedAt, expiresAt, channelId, forumId, guildId, botToken, webhookUrl, discordUrl, actor, transport, allowed_mentions, embeds, files, attachments, flags, nonce, enforce_nonce。
strict parserの技術選択はStep 2で行うが、重複member400等の契約は未決にしない。

### 上限と文字数

公式はname100/content2000 characters、forum request全体25MiB。これは添付等を含む上流の上限。
本APIはJSON16,384 UTF-8バイト、読取5秒、非圧縮application/jsonだけ。Content-Lengthを偽装してもstreamで超過検知。
UTF-8 fatal decode、max depth3（root＋tagIds）、許可field4件、重複member拒否。header Idempotency-Key最大1024 ASCIIバイト。
文字数は既存JS lengthと同じUTF-16。BMPの日本語は1、絵文字のsurrogate pairは2、結合/ZWJは各要素を数える。
公式は内部の文字数単位を明記していないため、本アプリの保守的な受付単位として確定。Discord内部と同一とは断定しない。
ブラウザとWorkerで100/101、2000/2001、emoji50/51組、CRLF、結合文字、surrogateを境界試験する。
未知fieldやJSONエラーは400、超過413、Content-Type/Content-Encoding不適合415、read timeout408、意味検証422。

## 3. 操作発行と署名キー

POST /api/forum/post-intentsはpayloadのschema/正規化、固定forum設定、sessionを検証する。DOが以下を発行してnot_startedをcommitする。
Bot投稿はゼロ。受付時のタグlive確認をしても投稿権限の証明とはしない。タグの最終live確認は送信attempt前。

~~~json
{
  "apiVersion": 1,
  "operationId": "123e4567-e89b-42d3-a456-426614174000",
  "idempotencyKey": "v1.<base64url-claims>.<hex-HMAC-SHA256>",
  "issuedAt": "2026-10-09T00:00:00.000Z",
  "expiresAt": "2026-11-08T00:00:00.000Z",
  "payloadHash": "<SHA256>",
  "status": "not_started"
}
~~~

架空の例。初回発行201。保存不可503 STATE_UNAVAILABLE、keyを返さずDiscord送信なし。
UUID v4はサーバー乱数。claimsの固定schema:
v=1, operationId, principal=personal-owner-v1, forumId（env由来）, payloadHash, issuedAt/expiresAt（整数ms）。
expiresAt=issuedAt+30*24*60*60*1000。hashはUTF-8の固定順JSON配列[1, threadName, content, sorted tagIds]のSHA256。
signatureはSESSION_SIGNING_KEYのHMAC-SHA256、入力はUTF-8の "forum-post-operation:v1."+base64url(claims)。
canonical encoding、正確なclaims key/type/値/期間を検証、signatureはcrypto.subtle.verify、domainをsessionと分ける。
SESSION_SIGNING_KEY、APP_PASSWORD_HASH、Bot Tokenは変更/追加しない。署名の値・ticketはログに出さない。

発行は履歴の保存を先にawaitしてからticket返却。ticket単体ではBearer認証の代わりにならない。
発行応答が失われた場合、その未開始操作はDiscordへ送られていない。ユーザーが確認したsnapshotの発行をやり直すことは可能。
一度POSTを開始したら、自動的に発行をやり直すことは禁止。same-key照会で回復する。
意図的再投稿だけ新しい発行要求を確認画面から行う。発行に既存UUID/日時を受け取らせない。

## 4. Botへの変換と投稿先/権限

POST先:
https://discord.com/api/v10/channels/{env.DISCORD_FORUM_CHANNEL_ID}/threads
Authorization: Bot <既存DISCORD_BOT_TOKEN>。クライアントに渡さない。Webhook Secretなし、wait queryなし。

~~~json
{
  "name": "<threadName>",
  "message": {
    "content": "<content>",
    "allowed_mentions": { "parse": [], "replied_user": false }
  },
  "applied_tags": ["<検証済みtagId>"]
}
~~~

type/auto_archive_duration/rate_limit_per_user/username/avatar/添付を任意指定させない。省略はDiscordの既定値。
固定forum GETからid/type15/guild_id/available_tags/flagsを確認。毎attemptで8名称の一対一mappingにselected IDsが属するか確認。
IDの消滅/他forum/重複/その他名称、selected名称の重複を422 TAG_INVALID。REQUIRE_TAGなのに[]は422 TAG_REQUIRED。
moderatedタグはMANAGE_THREADS必要。使用許可はサーバー側の有効権限確認で判定し、確認不能はTAG_PERMISSION_UNVERIFIEDで停止する。クライアントのselectable値/申告やGET tags成功から許可しない。権限計算に必要な追加読取は固定parentから得たguild/Botに限定し、公開proxyにはしない。
VIEW_CHANNEL/SEND_MESSAGES、必要時MANAGE_THREADSの有効権限はStep 6の受入事項。CREATE_PUBLIC_THREADSを前提にしない。
Administratorでも呼べるrouteは固定。PATCH/DELETEや任意Discord routeは公開しない。

### 応答receipt

Discordの成功は妥当な2xx＋Channel/nested message。アプリの201とは分けて扱う。
Channel.type=11、parent_id=固定forum、guild_id=GET親forumのguild、Channel.idが有効snowflake、
message.id/message.channel_idが有効、message.channel_id=Channel.idを確認。
threadId=Channel.id、messageId=message.id、guildId/forumIdは検証済み親とreceiptから保存。
初期message/thread同IDの仕様は参考にするが、欠落message.idをlast_message_id等で補完して成功扱いしない。
リンク: https://discord.com/channels/{guildId}/{threadId}/{messageId} をサーバー生成。threadUrlはmessageIdを省略した同固定hostのリンク。
replayは保存receiptの元guild/forumを使用。現在envで過去リンクを書き換えない。
不正JSON/receipt不足/IDやparent不一致/2xx本文timeoutはunknown。第三者URLやDiscord生bodyを返さない。

manual＋全3xx拒否。POST/応答本文全体で10秒deadline、本文64KiB上限。Locationへfollowしない。
read-only preflightの失敗は未作成。write開始後の3xx/5xx/network/timeoutはunknown。
Botが作成後に編集/削除できる仕様はDESIGN §3参照。アプリは公開編集削除APIを追加せず、失敗補償のdeleteも行わない。

## 5. 投稿と状態照会のレスポンス

POSTはBearer＋Idempotency-Keyを要求する。GET path UUIDもticketと一致必須。

~~~json
{
  "apiVersion": 1,
  "requestId": "server-generated-uuid",
  "operationId": "123e4567-e89b-42d3-a456-426614174000",
  "status": "succeeded",
  "replayed": false,
  "attempt": 1,
  "expiresAt": "2026-11-08T00:00:00.000Z",
  "safeToRetry": false,
  "retryAfterSeconds": null,
  "error": null,
  "result": {
    "guildId": "100000000000000002",
    "forumId": "100000000000000003",
    "threadId": "100000000000000004",
    "messageId": "100000000000000004",
    "threadUrl": "https://discord.com/channels/100000000000000002/100000000000000004",
    "url": "https://discord.com/channels/100000000000000002/100000000000000004/100000000000000004"
  }
}
~~~

errorは固定code/message/fieldsのみ。fieldsはfield名、値のechoなし。
safeToRetryは同ticket/同payloadで新しいDiscord attemptを始めてよい意味。GET照会可否ではない。
unknown/sending/succeeded/failed/expiredはfalse。not_started/retryableは期限/nextAllowedAt以内の許可条件を満たす場合true。
replayed=trueはこの要求で新Discord writeなし、保存状態の返却。attemptはbeginSend commit回数。発行直後0。
レスポンスなし（ブラウザtimeout等）からunknownと断定せず、まず同ID/ticketでGETする。

|state|画面|再送/遷移|
|---|---|---|
|not_accepted|受付拒否（HTTP用、履歴stateではない）|この要求のwriteなし。既存操作の有無はticketとGETで確認|
|not_started|未開始|有効ticket/同payloadでpreparingへ|
|preparing|送信準備中|15秒attempt lease、他要求202。古いattemptはCAS拒否|
|sending|送信中|beginSend永続化済み。他要求202、追加write禁止|
|succeeded|成功|receipt保存、再送不可、保存結果を返す|
|retryable|安全に再試行可能な失敗|非作成確定。wait後same-keyのみ|
|failed|確定した拒否/終端失敗|自動再送不可。修正/再投稿は確認画面＋新ID|
|unknown|投稿結果不明|same-ID照会だけ。自動retry/新key生成なし|
|expired|履歴期限切れ|410、追加write不可。新操作は意図的確認必須|

preparing→sending commitをawaitしてからfetch。準備lease切れは古いattemptを無効にした後retryableへ戻せる。
sendingが120秒超ならunknown。期限切れを再送許可にしない。
同attemptの遅い妥当receiptだけunknown→succeeded可。成功を失敗で上書きしない。
failed/retryableも30日でexpire。unknown履歴も30日以降削除するが、古いticketは永久に再送不可（署名expiryによる拒否）。

## 6. HTTP/error code

|HTTP|条件/code|結果|
|---|---|---|
|201|intent発行 / 新attempt成功|not_started ticket / succeeded receiptをcommit後返す|
|200|GET状態 / success replay|現在保存state、外部writeなし|
|202|POST中のpreparing/sending replay|safeToRetry=false、Retry-After:2でGET案内|
|400|INVALID_REQUEST / INVALID_OPERATION_KEY|未知field、JSON/Unicode、署名/claims不正|
|401|SESSION_REQUIRED / SESSION_EXPIRED|新attemptなし、再ログイン|
|403|ORIGIN_REJECTED / HOST_REJECTED|writeなし。上流Bot403と混同しない|
|404|ROUTE_NOT_FOUND|未知routeだけ。missing履歴を未開始とみなさない|
|405|METHOD_NOT_ALLOWED|新経路Allow header、旧APIとは分離|
|408/413/415|BODY_TIMEOUT / BODY_TOO_LARGE / UNSUPPORTED_MEDIA|parse段階、新writeなし|
|409|KEY_PAYLOAD_CONFLICT / TARGET_CHANGED / OPERATION_EXPIRING|同key別内容/別先、期限まで120秒未満で新attempt禁止|
|410|OPERATION_EXPIRED|署名キーの30日期限以降、DO削除済みでもwrite禁止|
|422|CONTENT_INVALID / TAG_INVALID / TAG_REQUIRED / TAG_PERMISSION_UNVERIFIED|送信前検証失敗|
|429|APP_RATE_LIMITED / DISCORD_RATE_LIMITED|異なるcodeとwait。操作はretryable/準備前|
|502|DISCORD_REQUEST_REJECTED / DISCORD_CREDENTIAL_REJECTED / DISCORD_PERMISSION_DENIED / DISCORD_TARGET_UNAVAILABLE|上流400/401/403/404の明確な拒否→failed|
|502|OUTCOME_UNKNOWN|送信後3xx/5xx/timeout/network/解析失敗、safeToRetry=false|
|503|STATE_UNAVAILABLE / SERVICE_UNAVAILABLE|送信前DO/GET障害は停止。送信後記録不能ならOUTCOME_UNKNOWN/sendingとして照会|

有効署名ticketなのに履歴なし:503 STATE_UNAVAILABLE。新recordにしない。期限外はDB lookup前に410。
schema失敗でoperationId=null可。認証失敗では保存状態を返さない。HTTPだけで成功/失敗/不明を判断しない。
responseはno-store/Vary:Origin/X-Content-Type-Options。Origin拒否にはallow-originを出さない。
preflight許可headers: Authorization,Content-Type,Idempotency-Key。Expose: Retry-After,Location。Locationは自APIの相対status pathのみ。

上流429は完全なHTTP429として受信した場合のみ非作成確定。body parse失敗でもstatus429の拒否を記録し、自動retryは停止する。
上流401はBot資格情報の失敗。ユーザーsessionを無効化するAPI401に変換しない。403/404も自動retryしない。
5xx/networkでは「明確に未投稿だった」と推測しない。receipt保存後返信が消えた場合はGETでsucceededを回収。

## 7. transactionと30日expiry

1. Host/Origin/Bearer、ticket署名/schema/期限、body正規化/hashを検証。UUID/principal/targetはticket/サーバー由来。
2. DOで履歴を読取。same payload終端はreplay、異payload409、missing有効ticket503、pending202、unknownは再送禁止。
3. eligible操作のみ固定parentとタグlive GET。権限/配置拒否を記録。クライアントのcached mappingは権限証明ではない。
4. transactionで同record/state/attemptを再読しpreparingをCAS予約（15秒）。外部GET/fetchをtransaction内に置かない。
5. beginSend transactionでsession/expiry/target/hash/cooldownとglobal60秒rateを再確認。sending＋slot＋attemptをcommit/await。
6. 外側Workerが1回だけBot POST。beginSend応答を失ったら勝手に再許可を取得せずGETで確認。
7. same attemptのresultをexpiry以内にcommit/awaitして返信。commit不能/再起動後sendingはunknown、外部write再試行なし。
8. expiresAt以降POST/GET410。alarmとrequest時清掃で履歴を削除。清掃が遅れても公開しない、30日更新延長なし。

30日は発行時刻起点の論理期限。通常は最早期限のalarmで物理削除し、platform障害で清掃が遅れた場合は回復時に削除する。障害中にも期限外の読取/書込は許可せず、厳密なリアルタイム物理削除を保証したとは扱わない。
GETは保存された発行時targetの結果を照会できる。POSTの新attemptだけ現在の固定forumとticket/recordのtarget一致を要求する。target変更を理由に同IDで新スレッドを作らない。

署名鍵交換、DBデータ消失、target変更で既存keyを新規化しない。操作を発行し直すには新しい確認画面が必要。
1時間session expiryで履歴を消さず、同Ownerの再ログインで同keyを照会できる。
新規signature発行は新UUIDだけ。過去UUID/claimsを新期限で再署名するpublic APIなし。
署名期限は保管されたrecordなしで検証できるため無期限tombstone不要。strict exactly-onceなし、安全側unknownの可能性あり。

## 8. 全利用者10件／60秒・Discord429

既存DOのapp-wide posts:rateに最大10個のbeginSend timestampを保存。session/利用者/forumごとに分割しない。
window(t)={slot | t-60000 < slot <= t}。tはDOのserver time。時計後退時は保存したlastRateNowとの最大値を使い、quotaを早期解放しない。10なら新attempt429 APP_RATE_LIMITED。
Retry-After=ceil((oldest+60000-t)/1000)、最低1。同じnowの11並行要求で許可10、拒否1。
slot挿入、state CAS、attemptCount増加は同transaction。永続化成功前のfetchなし。
POST拒否/Discord429/unknownも1slot。commit後fetch前crashもslot返却なし。安全側に上限を数える。
not_started発行/GET/replay/pending再要求はslotなし。safe retryで新fetchを始める場合は1slot追加。
DO不通/書込失敗は503で閉じる。ローカルcounterやquota無視の経路なし。

Discordのbucket/globalは同BotのGET/POST間で共有する。Botを他アプリでも使う場合、その使用量は本DOでは把握できず上流429を最終権威とする。
Retry-After/retry_after/Reset-Afterのfinite positive値の最大wait＋小jitter。global/bucket scopeとnextAllowedAtをDOへ記録。
上流waitを60秒へ切り縮めない。waitが取れない429は保守的60秒cooldown＋manual retryのみ。malformed waitで0秒連打しない。
same-key自動retryは明確な429と有効waitの場合だけ、初回＋3retryの最大4attempt。Worker内sleepなし、UIがwait後同ticketで再要求。
投稿後timeout/5xxをこのloopへ入れない。APP_RATE_LIMITEDで外部write未開始ならattemptCountは増加しない。
GET/pending pollは2秒から10秒へbackoff。read/intent濫用対策は別制限/監視とし、10件の投稿quotaに混ぜない。投稿budgetを操作発行時に消費したことにしない。

## 9. UI/本番境界

confirm→login（必要時）→tags ID確定→snapshot確認→intent発行→sessionStorage保存→POST。
storage/履歴永続化失敗はDiscord送信前停止。beforeunload/通信断で新intentへfallbackしない。
reloadはoperationId＋ticketでGET、期限切れ410表示。同一内容の再投稿は確認画面で新発行、unknownは手動確認先行。
Webhook入力/保存/参照/直送はStep 4撤去。旧Webhook削除はStep 6のBot実投稿確認後。TokenをUIへ送らない。

[公式Forum仕様](https://docs.discord.com/developers/resources/channel) /
[権限/編集削除](https://docs.discord.com/developers/topics/threads) /
[mentions](https://docs.discord.com/developers/resources/message) /
[rate](https://docs.discord.com/developers/topics/rate-limits)。
署名操作・30日・10件/分・UTF-16/16KiBは本アプリ契約でありDiscord公式が定めたものではない。

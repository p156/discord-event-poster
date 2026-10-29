# Ownerの安全な読み取り接続（2026-10-29）

本番はNO-GO。対象は固定Worker `discord-event-poster-api`。この手順は接続準備と管理metadata調査に限り、停止、Secret登録、upload、deploy、Discord投稿、main変更を許可しない。

## 最小のOwner操作

1. ローカルの信頼できるコンソールで、この開発ブランチのソースと使用するNodeを確認する。画面共有、録画、デバッガー、入力を採取する監視のない環境で行う。資格情報をチャット、引数、ファイルへ書かない。既存Tokenを安全に利用できない場合はここで止める。発行・権限追加・refreshは本手順に含まない。
2. リポジトリのルートで `powershell -NoProfile -File .\worker\tools\owner-readonly-evidence.ps1` を手動実行する。実行ポリシーは変更しない。署名ポリシーなどで拒否された場合は止める。
3. 固定Cloudflare管理APIへのGETを行うことを確認し、`READ` を入力する。既存Account IDと既存読み取りTokenを非表示プロンプトへ入力する。これはOwnerが行う明示接続操作であり、エージェントは代行しない。
4. 成功時のJSONだけを確認する。`status=PASS` はmetadataの照合成功に限る。常に `productionGo=false`。停止時は `OWNER_EVIDENCE_STOPPED` と、固定語彙だけの診断行を表示する。失敗原因の調査でも生のstderr、HTTP本文、ヘッダーを出力しない。権限不足・未知schema・分割deploymentなどを推測で補完しない。
5. 安全に保存したい場合も、確認済みの出力JSONだけをGit対象外の `work/` へ手動保存する。入力・生応答は保存しない。既存preflightへ自動投入しない。

今回の実行環境ではPowerShellのAuthorizationManagerがスクリプト起動を拒否した。
ポリシー変更や回避は行っていない。
同じ制約があるOwner環境では、既存の許可された署名/実行基盤でこの入力器をレビューして利用できるまで接続を止める。
Nodeへの資格情報の手入力や平文ファイルを代替にしない。

入力はSecureStringから一時的にメモリーへ展開し、子Nodeプロセスの匿名stdinへ渡す。子の引数・環境へTokenを入れず、入力処理とエラー出力を固定する。Node hook/debug環境変数は子から除去する。永続化は行わない。ただしPowerShell/JavaScriptの不変文字列、OSのメモリーやクラッシュダンプから完全消去できる保証はない。入力機構の実コンソールでの非表示確認はOwner接続前に必要で、今回の自動試験はモックと構文検査である。

## APIの範囲と権限

GET先、無retry、10秒/応答1MiB、redirect拒否は既存readerの制約を維持する。Owner専用のDeployments巡回だけを追加した（下記2026-10-29複数ページ対応参照）。他APIとrelease用reader既定の複数ページ拒否は維持する。Token探索、Wrangler login、Global Keyへのfallbackはない。
最初にversions/deployments/environment/bindingsを取得し、完全UUIDと期待値をメモリー内に構成した後、既存inspectの全11資源を2巡する（単一ページなら計26 GET。Deploymentsの各巡回がPページなら26+3×(P-1)、最大83 GET。各ページ1回、失敗時は即中断）。
これは原子的snapshotでもロックでもない。
資源はAccount、Service、Versions、Deployments、production Environmentとbindings/routes/subdomain、固定Serviceのdomains、schedules、DO namespacesに限定する。業務用Workerのsession/status/OAuth/DOデータへアクセスしない。

Ownerは既存Tokenについて、対象Accountの読み取り権限と各endpointへのアクセス範囲をローカルで確認する。Workerコード読取の公式許可例はWorkers Scripts ReadやWorkers Content Read-Onlyだが、これだけでAccount/Service/DO等の全GETに十分とは主張しない。管理者・書込Tokenを必要とする設計にはしない。401/403なら中断し、許可を増やさず、不足endpointの権限要件を別途レビューする。本ツールはToken自体のpolicyを取得しないため、Tokenが読み取り専用であることのサーバー側証明はしない。GET固定のクライアント制限とToken側権限は別である。

出力は検査済みUUID、Account指紋、既知Secret名、mode、metadata指紋、明示されたcpu_ms/subrequests数値だけ。生settings、annotation、binding値、メール、URL、APIエラー本文は出力しない。未知Secret名、未知トップレベルsettings、未知limitsは停止する。元のSecret値同一性や暗号化forum IDは検証できない。
取得後のmetadata指紋変化は再レビュー対象で、自動で新基準へ追従しない。

## 全module、上限、停止Sと復旧

今回の入口は全module取得器ではない。公式script downloadはraw contentを返すが、それを任意のVersionに固定された全moduleの完全証拠と推定しない。稼働Versionに束縛された入口・全module名/種別/bytesとhash、完全metadataの安全な読み戻し形式を別途確定するまで `allModuleHashes=NOT VERIFIED`。生のWorkerコードにはハードコード秘密値があり得るので、そのままファイルやログへexportしない。
configuredLimitsの数値は実効値ではない。プラン、usage model、既定値、DO固有制限と対象Versionへの対応をOwnerがローカルで確認し、欠落値を一般上限表で埋めない。
旧稼働コードの証明、受付flagの旧版での意味、既受付sending/unknown/alarmの影響が未確認ならSを生成しない。現在のOAuth候補を旧版Sに転用しない。S/R/Tの完全UUIDと独立読戻し、単発反映と停止維持できる復旧経路が揃うまで承認要求しない。既存verifyCandidate/verifyRecoveryPairへこの要約JSONを投入しない。

## DiscordのOwner側読み取り手順

Bot TokenをCloudflareから取り出さない。既存Bot Tokenを安全に利用できるOwner側のAPIクライアントがない場合はNOT VERIFIEDのまま止める。新規発行・reset・権限変更・ユーザーToken利用は禁止。Authorizationはメモリーのみ、固定 `https://discord.com/api/v10`、GETのみ、redirect/retry禁止、10秒/1MiB制限、エラー本文非表示のクライアントをレビューしてからOwnerが接続する。このリポジトリにはDiscord用live clientをまだ接続していない。

必要な読取は順に `GET /users/@me`（bot=trueと完全Bot ID）、`GET /oauth2/applications/@me`（既知Application ID `1319011620185309265` とBot対応）、`GET /channels/{forum_id}`（Ownerが安全に確認したID、guild_id、type=15）、`GET /guilds/{guild_id}`、`GET /guilds/{guild_id}/members/{bot_id}`、`GET /guilds/{guild_id}/roles`。IDは数字のみを検査し、固定origin以外へ送らない。名前、投稿本文、応答全体は出力しない。Worker Secretのforum値との同一性は別のOwner証拠が必要で、入力したIDにアクセスできただけでは証明しない。

権限はBigIntでeveryoneとBot全rolesのORを取り、owner/Administratorの扱いを確認し、channelのeveryone overwrite、全role overwriteのdeny/allow集約、最後にmember overwriteを公式順序で適用する。View Channel、Send Messages、Embed Links、Read Message History、Attach Filesを確認する。View ChannelやSend Messages拒否時の暗黙制限、memberのcommunication_disabled_until、guildの制約、forumの利用可能タグ・必須タグ・moderated条件も確認する。Portalの権限計算表示だけで代用しない。API上の計算PASSも実投稿成功を保証しない。実投稿は別承認のまま。

## OAuth callback観測と将来のSecret入力

本ツールはcode/state付きcallbackもログ収集先も呼び出さない。アプリ内console禁止だけではinvocation URLを保護できない。Ownerは完全なobservability、invocation_logs、query redaction設定の有無とschema、tail/streaming tail、Logpush、Traces、外部destinationsをローカルで照合する。診断ログを維持したinvocation_logs=false案の差分・全出力経路をレビューするまで保護済みとしない。Logs変更も既存enabled=false必須ガードの緩和も今回行わない。
本番送信adapterと新5Secretの入力・実multipartへの束縛は未接続。今回のCloudflare Token入力器をそのままSecret登録器と呼ばない。将来は非表示入力から既存oauthBindingsへメモリーで渡し、既存鍵inherit/keep、actual multipart検査、journal、単発送信、独立読戻しを別承認で接続する。通常のwrangler secret put、平文ファイル、認証付きURLを使わない。

## ローカル検証

`node --test worker/tests/owner-readonly-evidence.test.cjs worker/tests/oauth2-release-gate.test.cjs worker/tests/production-release-protocol.test.cjs`

既存ガードのsourceStateは未追跡ファイルに厳格なので、追加ファイルのcommit後にガード全件を実行する。allowlistは緩めない。新試験は偽資格情報とmock HTTPのみ。実Token入力、実API接続、Discord実効権限、非表示入力の実コンソール操作はNOT TESTED。

根拠（2026-10-29 Context7と公式資料確認）：

- [Cloudflare Deployments](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/)
- [Version metadata](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/)
- [Script downloadと読取権限](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/get/)
- [Script/version settings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Discord Current User](https://docs.discord.com/developers/resources/user#get-current-user)、[Application](https://docs.discord.com/developers/resources/application)、[Permissions](https://docs.discord.com/developers/topics/permissions)

## 2026-10-29 停止調査と次の操作

調査開始時のGitHub開発HEADは `9195f52edd6930ef01546d3f978c0cff030b0964` と一致した。
旧版はPowerShellの全例外と子Nodeの全失敗を同じ表示へ潰し、stderrも捨てていたため、報告された表示だけでは原因もAPI到達も確定できない。
Token有効というOwner報告は尊重するが、本ツールのAccount範囲・endpoint権限・metadata照合成功とは別である。

入力後の停止候補はAccount形式（小文字16進32桁、trimなし）、Token形式（空・4096超・空白/制御文字を拒否）、子プロセス起動、JSON送信/解析、最初のversions GET、後続GET、metadata照合である。
READと両入力プロンプトまで進んだ場合、確認拒否とNode探索失敗はその実行の停止点ではない。Token入力処理自体の例外は残る。
Account/TokenはSecureStringからBSTR経由で取得され、検査後に匿名stdinだけへJSON送信する。PowerShellとNodeの両catchは元の例外を表示しない。

修正は診断だけで、入力を補正したり、権限・schema・本番ガードを緩めたりしない。
PowerShell側は固定stageを表示する。ACCOUNT_FORMAT/TOKEN_FORMAT/PROCESS_STARTなど、子への送信前はapiAttempted=NO。
STDIN_WRITE/CHILD_WAITで子の安全な診断を得られない場合はUNKNOWNとし、未接続と断定しない。
子はINPUT/COLLECT、apiAttempted=YES/NOと固定codeだけを返す。YESはfetch呼出しを試行した意味で、サーバー受信の証明ではない。
AUTHORIZATION_REJECTEDは401/403、HTTP_REJECTEDはそれ以外のHTTP失敗、NETWORK_OR_TIMEOUTは接続/timeout分類、VALIDATION_OR_INTERNALは未知schema等を含む。
入力値、Account ID、URL、HTTP本文、例外messageやstackは診断に含めない。子stderrは行全体が許可形式に一致した場合だけ表示する。

Ownerの次の一手は、更新済み開発ブランチを確認したうえで、上記手順2の同じコマンドを信頼できる私用コンソールで手動実行すること。
これはOwnerが明示的に接続を選ぶ操作である。自動再実行はしない。
停止した場合は固定の停止行と診断行だけを共有する。資格情報や生エラーは共有しない。
NOならローカル入力/起動段階を、YESなら分類に沿って調査する。401/403でもToken再発行や権限追加はしない。
本番NO-GO、実効上限・全module・停止復旧などの未検証項目は継続する。

静的解析とダミー資格情報のモックのみを使用した。Owner秘密値・端末履歴は未参照、Cloudflare/Discordには未接続。
この環境の匿名stdin既定encodingはshift_jisで、ASCIIダミーJSONはそのまま届いた。BOM原因は再現せず、断定しない。BOM付きJSONの安全停止はテストする。
実コンソールの非表示入力から成功することは未検証のまま。実行ポリシーは変更・回避しない。

## 2026-10-29 AUTHORIZATION_REJECTEDの静的調査

調査基点は `30a51f3a95034f638f77664a7dffa55e5f414860`、開発ブランチ `event-poster-v2`。
Owner報告のToken active、全アカウント対象、Workers Scripts Read、期限/IP制限なしは前提情報であり、エージェントはToken、資格情報、端末履歴を参照していない。

`oauth2-release-gate.cjs` のreaderは、fetchのHTTP応答が非成功でstatusが401または403の場合だけ `AUTHORIZATION_REJECTED` を投げる。
ローカルのAccount形式検査、metadata/schema不一致、HTTP 200のsuccess=falseを認可拒否と誤分類する経路はない。
したがって旧ログは「少なくとも1回のGETでHTTP 401/403を受けた」ことを示すが、失敗先と401/403の区別は復元できない。
Token verifyはこの収集器から呼ばない。Bearerヘッダーは入力Tokenをそのまま使い、Account IDは形式だけを先に検査する。
有効な別Account IDやZone IDも形式検査を通り得る。実在/所属/配置先の一致は、形式とToken activeだけでは証明できない。

以下のパスは仕様のテンプレートで、実値を表示するものではない。`A` はAccount、`W` は固定Worker、`E` は `/accounts/A/workers/services/W/environments/production`。
全てGET。初回1〜4の後、表の5〜15を2巡し、合計26回。各失敗で即停止、retryなし。

| 初回順 / 以後の巡回順 | 固定診断ID | パステンプレート | 読取権限の確認結果 |
| --- | --- | --- | --- |
| 1 / 7 | VERSIONS | /accounts/A/workers/scripts/W/versions | Workers Scripts Readを公式仕様が許可 |
| 2 / 8 | DEPLOYMENTS | /accounts/A/workers/scripts/W/deployments | 同上 |
| 3 / 9 | ENVIRONMENT | E | 公開API資料で当該パスの必要権限は未確定 |
| 4 / 10 | BINDINGS | E/bindings | 同上 |
| 5 | ACCOUNT | /accounts/A | Workers Scripts Readを公式仕様が許可 |
| 6 | SERVICE | /accounts/A/workers/services/W | 公開API資料で当該パスの必要権限は未確定 |
| 11 | ROUTES | E/routes?show_zonename=true | 同上。zone版routesの権限を流用しない |
| 12 | DOMAINS | /accounts/A/workers/domains/records?page=0&per_page=5&service=W&environment=production | 同上。公開の別パス /workers/domains と同一扱いしない |
| 13 | SUBDOMAIN | E/subdomain | 公開API資料で当該パスの必要権限は未確定 |
| 14 | SCHEDULES | /accounts/A/workers/scripts/W/schedules | Workers Scripts Readを公式仕様が許可 |
| 15 | NAMESPACES | /accounts/A/workers/durable_objects/namespaces?page=1&per_page=100 | 同上 |

Service系6パスは固定済みWrangler 4.149.0の `fetchWorkerConfig` 等でも使用されていることをローカルソースで確認した。ただしSDK/CLIの使用実績は必要権限の証明ではない。
公開仕様で確認できた5パスについては既存権限で実行可能な設計である。Account Settings ReadやDO用追加権限が必須という根拠はない。
残る6パスを含む全26 GETが既存Tokenで成功するかは未確定で、追加権限が必要とも断定しない。

公式根拠（Context7で検索後、公開API referenceのAccepted Permissionsを照合）：

- [Versions一覧](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/list/)
- [Deployments一覧](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/)
- [Account詳細](https://developers.cloudflare.com/api/resources/accounts/methods/get/)
- [Schedules](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/get/)
- [DO namespaces一覧](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/methods/list/)

### 安全な診断の追加とOwnerの次の操作

新診断は既存行に `api=VERSIONS http=403 request=1` のような固定API識別子、HTTP数値、リクエスト通番だけを付ける。
API識別子は固定パスとの完全一致から生成する。応答本文、ヘッダー、URL、Account ID、Token、例外文は読み出して表示しない。
応答を得る前の失敗はhttp=NONE。metadata照合失敗ではapi/httpは最後の取得を示し、そのAPI自体の失敗を意味しない。
PowerShellも診断全体を許可形式で検査し、それ以外のstderrは破棄する。API集合/順序/GET限定/timeout/サイズ/schema/NO-GOガードは変更しない。

1. Owner自身がDashboardの対象WorkerのAccount IDをローカルで照合する。Zone ID、ユーザーID、別アカウントとの取り違えを確認し、ID自体を共有しない。
2. 更新済み開発ブランチで、上記の同じPowerShellコマンドを私用コンソールから手動実行する。既存Tokenを使い、再発行・権限追加は行わない。実行ポリシーは変更しない。
3. 停止行と固定診断行だけを共有する。例えば `code=AUTHORIZATION_REJECTED api=VERSIONS http=403 request=1` なら最初のVersions取得で拒否。Account ID照合後も拒否なら、入力した既存Tokenと検証したTokenの同一性をOwner側だけで確認し、権限反映/対象/サーバー側認可を当該パスに絞って調査する。
4. SERVICE/ENVIRONMENT等なら、先行GETは成功しているためToken全体の無効と即断せず、当該パスの権限仕様または公開APIへの置換を別途検討する。401と403だけでは拒否の詳細原因は確定しない。追加権限なしでは取得不可と確認された場合も、勝手に権限を増やさず収集を止める。

モック検証では26箇所それぞれの403を正しく識別し、即停止と秘密marker/URL/Accountの非出力、PowerShellの許可形式を確認する。実APIの拒否原因はOwnerの次回診断まで未確定。本番NO-GOは継続。

## HTTP 200 / DEPLOYMENTSのAPI_RESULT_REJECTED調査（2026-10-29）

対象基点は d9ab880。共有されたrequest=2は1回のcollect開始後のGET通番であり、retry回数やページ番号ではない。順序はVERSIONS、DEPLOYMENTS、ENVIRONMENT、BINDINGS、その後11資源を2巡。今回Versionsのreader検査は通過したが、Versions内のID検査やAccount詳細照合まで完了した意味ではない。

旧readerがAPI_RESULT_REJECTEDを投げる条件は、JSON解析後の次のOR条件だけだった。

1. success !== true（falseだけでなく欠落・異なる型を含む）
2. 自身のresultキーがない
3. result_info.total_pages > 1（JavaScriptの比較。旧条件を変更しない）

JSON不正はRESPONSE_INVALID、サイズ超過はRESPONSE_TOO_LARGE、HTTP 401/403はAUTHORIZATION_REJECTEDであり別分類。result:null、配列、deployments欠落・空・不正なversions等はresultキーがある限り上記2には該当しない。後続のmetadata照合でVALIDATION_OR_INTERNAL等になる。共有された1行からsuccess:falseやresult内部構造の不一致を断定することはできない。

[公式Deployments一覧](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/)をContext7と公開referenceで確認した。GETのパスは /accounts/{account_id}/workers/scripts/{script_name}/deployments。account_idはWorker所属Account、script_nameはWorkerスクリプト名であり、固定対象はdiscord-event-poster-api。Zone ID、Token ID、deployment/version UUID、workers.devのホスト名ではない。同名Workerが別Accountに存在しても別資源となる。入力Accountと固定Worker名はVersionsにも共通なので、通番1の成功だけで意図したAccountの同一性が証明されるわけではない。Dashboard上でOwnerがローカル照合する。

公式の成功形式はsuccess:true、result:{deployments:[...]}。先頭deploymentが現在トラフィックを処理する最新deployment。page/per_page等のqueryと任意のresult_infoがあり、公式200例にもtotal_pages:100が載る。そのため正常な履歴の複数ページをローカルのpagination拒否が停止させる可能性がある。これは今回の有力な切り分け候補だが、実応答を見ていないため未確定。公式例は実環境のページ数を示す証拠ではない。Workers Scripts Readは当該GETのAccepted Permissionsに含まれ、現在の証拠から追加権限やToken再発行を要求しない。Token activeという情報だけで各資源の応答内容までは証明されない。

### 追加診断と再実行

API_RESULT_REJECTEDの末尾に次の固定detailだけを付ける。複数条件に該当した場合は上から優先して1つ表示する。

| detail | 意味 | 次の判断 |
|---|---|---|
| SUCCESS_FALSE | JSONのsuccessがboolean false | HTTP 200のAPI失敗応答。エラー本文は共有せず、この行を根拠に次の安全な調査を検討 |
| SUCCESS_NOT_TRUE | success欠落・型違い等 | 標準envelopeとの差異。成功扱いへ推測で変換しない |
| RESULT_MISSING | success:trueだがresultキー欠落 | envelope形式不一致。result内部の型の問題とは区別 |
| MULTIPLE_PAGES | success:true、resultキーあり、total_pages > 1 | ローカルpagination拒否。API失敗や権限不足を示さない。先頭の稼働deploymentだけを検証する取得設計を別途レビュー |

新診断は本文・URL・ヘッダー・Token・Account ID・APIメッセージ・数値エラーcode・ページ数を表示しない。GET集合、停止条件、サイズ、timeout、無retry、2巡照合、NO-GOは維持。実応答不明のまま自動ページ巡回やpagination許容へ変更しない。

Ownerは更新済みevent-poster-v2で、対象Workerの所属Accountと名前をDashboard上でローカル確認後、既存Tokenのまま従来のPowerShellコマンドを私用コンソールで実行する。停止時はdetail付き診断行だけを共有する。例：

```text
OWNER_EVIDENCE_STOPPED phase=COLLECT apiAttempted=YES code=API_RESULT_REJECTED api=DEPLOYMENTS http=200 request=2 detail=MULTIPLE_PAGES
```

上記は想定例であり実測ではない。実API接続、資格情報閲覧、main更新、本番設定/Secrets/デプロイ/投稿は行っていない。本番NO-GOを維持する。

## 2026-10-29 MULTIPLE_PAGES確定後の対応（基点369bbc1）

Ownerの報告は `http=200 request=2 detail=MULTIPLE_PAGES`。これはsuccess:trueとresultキーの存在を通過後、total_pages>1という旧ローカル制限で停止したことを確定する。Tokenの全資源への権限やAccount同一性、証拠収集完了を証明するものではない。上の「未確定」「pagination拒否」「26回固定」は旧時点の調査記録で、この節が現在の実装を示す。

### 公式仕様と取得範囲

[Cloudflare Deployments公式API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/) をContext7と公開referenceで確認。pageは1以上、per_pageは1〜100。result.deploymentsが履歴で、先頭が現在トラフィックを処理する最新deployment。result_infoと各フィールドは公式schemaではoptionalである。

Owner収集だけがreaderのownerDeploymentsを有効にする。初回は従来の固定パス（既定page=1）を取得し、複数ページなら返却per_pageを固定してpage=2から順番に取得する。next URLや本文中のURLは追跡しない。固定origin/Account/Worker/GETのみ。ページ上限20、各ページ100件以下、合計2000件以下。初回の既定per_pageが20なら最大400件であり、上限回避の再取得・自動拡大はしない。

複数ページではpage/per_page/count/total_count/total_pagesを非負の安全な整数として要求し、正しいページ番号、ページサイズ、最終ページまでの各件数、総件数と総ページ数の算術的整合、巡回中の総数不変を検査する。欠落や不完全なmetadataは推測しない。UUID重複・同じページの再返却を拒否する。API順序をそのまま維持し、再ソートで先頭を選び直さない。追加の保守的ローカル条件として複数ページ時のcreated_onが有効で降順であること、先頭2件が同時刻でないことを要求する。公式は履歴全体の時刻降順や同時刻の順序を明記していないため、これに合わない応答は安全停止して個別レビューする。

result_infoがない旧単一応答、またはtotal_pages:1だけの旧単一ページ形式は従来通り扱う。これらはページ情報による履歴全体の完全性証明ではない。部分的な複数ページmetadata、途中ページでのmetadata消失、total_pages:0は停止する。空履歴は稼働deploymentを確定できず停止する。

初回に全履歴をメモリー内で保持し、既存inspectの2巡でも毎回全ページを読み、初回と履歴全体を照合する。稼働deployment ID、単一Version/100%配分、latestVersion、設定等の既存照合も維持する。最新Versionと稼働Versionの同一性は要求せず、未デプロイVersionを許容する。履歴末尾だけの変更でも停止する。これは原子的snapshotやロックではなく、ページング中に検出できない相殺変化まで否定するものではない。

[Versions公式API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/list/) にもpage/per_pageがあり、deployableはpaginationを無視する別フィルターである。本修正でdeployableやVersionsの取得意味は変更しない。Versions、Namespaces、Domains等は複数ページなら従来のMULTIPLE_PAGESで停止し、切捨て成功にはしない。releaseのinspect/preflight既定readerも従来の複数ページ拒否を維持する。Owner出力をそのままrelease基準に昇格させない。

### 失敗・診断

途中失敗、上限、順序不一致、履歴変化では部分結果やPASSを出さず停止する。再試行なし、各GETの10秒/1MiB、redirect拒否は継続。ページは順次取得し、最大83 GET（最悪の各GET期限の単純合計は830秒）。requestはページ番号でもretry回数でもなく、その実行でのfetch試行通番。後続ページもapi=DEPLOYMENTSで分類し、PowerShellはrequest=1〜83のみ許可する。http=NONEは応答前失敗。後続metadata照合エラーではapi/httpは最後の取得を示す。

| detail | 意味 |
|---|---|
| PAGINATION_LIMIT | ページ数・件数・ページサイズの上限超過 |
| PAGINATION_INVALID | 番号、件数、metadataの欠落・型・整合性不一致 |
| PAGINATION_CHANGED | 同一巡回中のページサイズ・総数変更（算術検査に先に失敗する場合はINVALID） |
| PAGINATION_DUPLICATE | deployment UUIDの不正・重複 |
| PAGINATION_ORDER | 日時欠落・不正・逆順・先頭時刻の同順位 |

SUCCESS_FALSE / SUCCESS_NOT_TRUE / RESULT_MISSINGは引き続きenvelope失敗を表す。巡回間の履歴変更等はVALIDATION_OR_INTERNAL。本文、ヘッダー、URL、Account ID、Token、annotation、メール、例外文、ページ内データは表示しない。

### Ownerの次の手順

1. 更新済みevent-poster-v2のcommitと固定Worker名、所属Accountをローカル確認する。
2. 信頼できる私用コンソールでリポジトリルートから従来と同じコマンドを実行する。

```powershell
powershell -NoProfile -File .\worker\tools\owner-readonly-evidence.ps1
```

3. READを入力し、既存Account/読み取りTokenを非表示プロンプトだけへ入力する。資格情報の共有・新規発行・権限追加・実行ポリシー回避はしない。
4. 停止時はdetail付きの固定診断行だけを共有する。LIMITなら上限を自己変更せず停止、INVALID/CHANGED/DUPLICATE/ORDERならmetadata/同時変更の追加レビューを行う。他APIのMULTIPLE_PAGESは今回の対象外なので別レビューする。生応答は共有しない。
5. PASSもmetadata照合だけ。productionGo=false / releaseEligible=false、全module・実効上限・停止復旧等のNOT VERIFIEDを維持する。本番NO-GOは継続する。

検証は合成応答とダミー資格情報のみ。実API接続、資格情報閲覧、main変更、本番デプロイ/Secrets/設定変更は実施しない。

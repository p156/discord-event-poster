# Ownerの安全な読み取り接続（2026-10-29）

本番はNO-GO。対象は固定Worker `discord-event-poster-api`。この手順は接続準備と管理metadata調査に限り、停止、Secret登録、upload、deploy、Discord投稿、main変更を許可しない。

## 最小のOwner操作

1. ローカルの信頼できるコンソールで、この開発ブランチのソースと使用するNodeを確認する。画面共有、録画、デバッガー、入力を採取する監視のない環境で行う。資格情報をチャット、引数、ファイルへ書かない。既存Tokenを安全に利用できない場合はここで止める。発行・権限追加・refreshは本手順に含まない。
2. リポジトリのルートで `powershell -NoProfile -File .\worker\tools\owner-readonly-evidence.ps1` を手動実行する。実行ポリシーは変更しない。署名ポリシーなどで拒否された場合は止める。
3. 固定Cloudflare管理APIへのGETを行うことを確認し、`READ` を入力する。既存Account IDと既存読み取りTokenを非表示プロンプトへ入力する。これはOwnerが行う明示接続操作であり、エージェントは代行しない。
4. 成功時のJSONだけを確認する。`status=PASS` はmetadataの照合成功に限る。常に `productionGo=false`。停止時は `OWNER_EVIDENCE_STOPPED` のみ表示する。失敗原因の調査でも生のstderr、HTTP本文、ヘッダーを出力しない。権限不足・未知schema・分割deploymentなどを推測で補完しない。
5. 安全に保存したい場合も、確認済みの出力JSONだけをGit対象外の `work/` へ手動保存する。入力・生応答は保存しない。既存preflightへ自動投入しない。

今回の実行環境ではPowerShellのAuthorizationManagerがスクリプト起動を拒否した。
ポリシー変更や回避は行っていない。
同じ制約があるOwner環境では、既存の許可された署名/実行基盤でこの入力器をレビューして利用できるまで接続を止める。
Nodeへの資格情報の手入力や平文ファイルを代替にしない。

入力はSecureStringから一時的にメモリーへ展開し、子Nodeプロセスの匿名stdinへ渡す。子の引数・環境へTokenを入れず、入力処理とエラー出力を固定する。Node hook/debug環境変数は子から除去する。永続化は行わない。ただしPowerShell/JavaScriptの不変文字列、OSのメモリーやクラッシュダンプから完全消去できる保証はない。入力機構の実コンソールでの非表示確認はOwner接続前に必要で、今回の自動試験はモックと構文検査である。

## APIの範囲と権限

GET先、無retry、10秒/応答1MiB、redirect拒否、pagination拒否は既存 `oauth2-release-gate.cjs` のreaderをそのまま使用する。Token探索、Wrangler login、Global Keyへのfallbackはない。
最初にversions/deployments/environment/bindingsを取得し、完全UUIDと期待値をメモリー内に構成した後、既存inspectの全11資源を2巡する（計26 GET、各1回、失敗時は即中断）。
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

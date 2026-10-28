# OAuth2公開と復旧の手順

2026-10-29追記：Ownerの非表示資格情報入力と初回metadata調査は [OWNER-READONLY-CONNECTION.md](OWNER-READONLY-CONNECTION.md) を参照する。metadata要約は公開基準や全module証拠の代用にしない。本番NO-GOを維持する。

対象は `p156/discord-event-poster` の `event-poster-v2` です。
この手順は公開前の検証を具体化したもので、公開許可ではありません。
「mainに上げる」は本番公開として扱い、明示承認を得るまでマージしません。

## 検証ツールの役割

`worker/tools/oauth2-release-gate.cjs` は読み取り専用です。
`prepare` は投稿停止のbundleと設定をローカルへ作成し、`verify` は改ざんやソースの変更を検査します。
`preflight` は固定Cloudflare APIへのGETだけを行い、確認済みの本番設定と照合します。
upload、deploy、Secret更新、Portal操作の経路はありません。
`--execute` や書き込み用の引数を渡すと拒否します。

出力の `productionGo` は常に `false` です。
PASSはその検査の成功を意味し、本番公開の承認や実Discordでの合格を意味しません。
旧Stage 1のツールとテストは当時の設定を保持しています。
今回のOAuth2公開には使用しません。

### ローカル候補の作成

リポジトリのルートで、対象SHAを明示して実行します。
出力先は `work/oauth2-release/` の子ディレクトリに限定されます。
既存ディレクトリは上書きせず、symlink経由の出力も拒否します。

```powershell
npm run release:gate -- prepare --release work/oauth2-release/candidate-20261013 --expected-sha fb582c89c7588dc99125d0438648e21ca67b7a63
npm run release:gate -- verify --release work/oauth2-release/candidate-20261013
```

候補には `index.mjs`、`wrangler.json`、`release.json` が入ります。
bundleは現在のWorkerソースをインストール済みの固定esbuildで再構築します。
設定は正規 `worker/wrangler.jsonc` から作り、mainの場所を候補内へ変更し、`FORUM_POSTS_ENABLED=read-only` と `preview_urls=false` を追加します。
DO binding、class、migrationは変更しません。
既存の投稿署名鍵を置換する設定やSecretの値は候補に含めません。

manifestにはソースファイル、設定、bundle、検証ツールのハッシュを保存します。
verifyではソースから再構築したbundleとも比較するため、bundleとmanifestのハッシュを両方書き換えても通りません。
repo、branch、HEAD、originも確認します。
許可したツール、テスト、文書とnpm script以外の変更、依存の変更、rename、deleteは拒否します。
変更をコミットした場合も、自動で対象SHAを更新せず、レビュー済みの新SHAで新しい候補を作成します。

本番基準を付けずに作った候補はローカル検証用です。
`remoteBaselineBound=false` となり、preflightを実行できません。
この段階で本番CPU設定を引き継いだとは主張しません。

### 本番の確認値を固定する

本番の読み取り確認を行う段階で、対象環境と照合した期待値ファイルをGit対象外の場所へ作成します。
Account IDやnamespace、Versionを記憶や古い報告から補いません。
空欄のままではツールが停止します。
このファイルはSecret値を含めません。

```json
{
  "schema": 1,
  "accountSha256": null,
  "worker": "discord-event-poster-api",
  "namespaceId": null,
  "activeVersion": null,
  "latestVersion": null,
  "deploymentId": null,
  "mode": null,
  "secretNames": [],
  "settings": null
}
```

`accountSha256` はローカルで確認したAccount ID文字列のSHA-256です。
元のIDはチャットや報告書に出しません。
activeVersion、latestVersion、deploymentIdは別々のAPI値を確認します。
旧環境応答の補助的なdeployment_idを代用しません。
modeは停止後に確認した `absent`、`false`、`read-only` のいずれかです。
稼働中の `true` を基準にしたpreflightは拒否します。

secretNamesには現在存在するSecret名を完全な集合で記録します。
既存のALLOWED_ORIGIN、Bot Token、投稿先、投稿署名鍵、APP_PASSWORD_HASHを維持します。
新OAuth2の5名が未設定の旧環境も検査できますが、`oauthSecretNamesPresent=false` を返します。
これは移行前の基準確認であり、新認証が準備できたことを意味しません。

settingsには環境応答のscriptから、ツールの `SETTING_KEYS` にある設定だけを記録します。
compatibility_dateとmigration_tagは必須です。
CPU上限、subrequest上限、観測設定などが実在する場合は省略しません。
未設定とnullは同じものとして扱いません。
未知のトップレベル設定、許可していない機能、routes、domains、schedule、公開previewは停止理由になります。
APIの応答形式が異なる場合も、検査を緩めず記録を確認します。

```powershell
# expectations-reviewed.json は本番で確認してレビューした値だけを含むローカルファイル
npm run release:gate -- prepare --release work/oauth2-release/reviewed-candidate --expected-sha fb582c89c7588dc99125d0438648e21ca67b7a63 --expectations work/oauth2-release/expectations-reviewed.json
npm run release:gate -- preflight --release work/oauth2-release/reviewed-candidate --expectations work/oauth2-release/expectations-reviewed.json
```

preflightではローカル環境変数 `OAUTH_GATE_CF_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN` を使用します。
値の入力はローカルの安全な方法で行い、チャットに貼りません。
CLI引数に資格情報を入れません。
環境変数がなければ停止し、Wranglerのlogin、資格情報refresh、Global Keyへのfallbackは行いません。

基準付き候補は、確認した `limits.cpu_ms` と `limits.subrequests` を設定へ引き継ぎます。
基準なし候補に後から期待値を渡して公開用に格上げすることはできません。
manifestに束縛された期待値とpreflightの期待値が一致することを確認します。

GET先はAccount、固定Worker、production環境、Version一覧、deployment、binding、routes、domains、subdomain、schedule、DO一覧に限定します。
各GETは1回だけで、redirect、401、403、429、5xx、timeoutで停止します。
各応答の読み取りを10秒、1MiBまでに制限します。
同じ全項目を2巡して、途中のVersionや設定変更も検出します。
これはロックや原子的snapshotではありません。
公開直前にも再検査が必要です。
paginationが必要な応答は、自動で追跡せず停止します。

## 公開操作を承認する前の条件

ローカル検証後に、Portal変更、Secretを伴う候補upload、Worker切り替え、Pages反映、実OAuth、true切り替え、実投稿をそれぞれ具体化します。
実投稿は固定フォーラムへの画像付き1件と画像なし1件を提案し、本文と画像を確認してから承認を得ます。
本番操作の承認は、このツール整備の承認と分けます。

uploadするmultipart metadataは、実際に生成したものを `assertUploadMetadata` へ渡して検査します。
main_module、9必須binding、既存4必須Secretのinherit、新OAuth2の5名、keep_bindings、DO、read-only、CPU設定を確認します。
既存Secretをsecret_textで置換するmetadata、余計なbinding、migration payload、exports、trueへの変更は拒否します。
APP_PASSWORD_HASHなどの既存追加Secretはkeep_bindingsで保持します。
この関数は現行Wranglerの実form builderを使ったダミー値の試験で確認しました。
実uploadに接続して検査したことにはなりません。

Cloudflareの候補Version作成は、コードと新Secretを一つのVersionへ束ねる方式を使います。
通常の `wrangler secret put/delete` を準備作業として実行しません。
公式には `versions upload --secrets-file` があり、省略した既存Secretを保持できます。
ただし固定Wrangler 4.149.0のupload内部には `retryOnAPIFailure` があることを確認しています。
無再試行の条件を満たす本番実行経路として、このCLIをそのまま使用できるとは判定しません。

本番実行時には別途承認された単発API送信経路を用意します。
その経路でローカルverify、直前preflight、実multipart metadataの検査を実施し、固定Workerのversions endpointへ1回だけ送信します。
legacy PUT、force、自動再試行を許可しません。
この読み取り専用ツールにはその送信経路を接続していません。
未確認の本番応答形式を推測して実装を有効にすることもしません。

アップロード後は、返された候補Version IDを取得し、更新前active deploymentが変わっていないこと、新Versionのコードとbundle、Secret名、DO、mode、limitsが計画に一致することを確認します。
tagやmessageの一致だけでbundle同一性を証明しません。
本ツールのpreflightは移行前基準の検査なので、候補uploadによるlatestVersionの意図した変更も停止します。
候補確認後の切り替えは別の承認済み検査として扱います。
beforeとafterの基準を自動で書き換えて通過させません。

## WorkerとPagesの切り替え

1. 現行の受付を承認した方法で停止する。
   別タブを含む操作を確認し、受付済みpreflightやsendingを観測する。
   read-onlyで進行中処理が取り消されるとは判断しない。
2. 既存Bot ApplicationのOAuth2 Redirectに固定callbackを完全一致登録する。
   scopeはidentifyだけとし、Bot再作成やToken再生成は行わない。
3. 既存Secretを維持し、新5Secretをread-onlyコードと一つの候補Versionへ束ねる。
   AUTH_SESSION_SIGNING_KEYは64文字以上の独立乱数とし、SESSION_SIGNING_KEYを変更しない。
4. uploadとcandidate確認を通過した後、明示したVersionを100%反映する。
   旧PW認証Versionとの割合混在を避け、DOは同じnamespace、SQLite、AuthState、personal-auth-v1、auth-v1を維持する。
5. Worker停止capabilityを確認してから、承認されたmain更新とPages反映を行う。
   4assetのhash、CSP、固定API、公開除外、実ブラウザの読込を確認する。
6. 投稿停止中に実OAuth、本人限定、cancel、logout失効、旧Bearer拒否、旧操作GETを確認する。
   callbackのcodeやトークンを画面保存しない。
7. 別承認でtrueを反映し、画像preview、実Embed2件、CPU、メモリー、通信制限を確認する。
   previewもread-onlyでは404になるため、画像実検査は投稿経路を有効化する変更として承認する。
8. 異常または実検査未了なら、OAuth2を維持したread-onlyへ戻す。
   全合格後、通常運用の公開を別途承認する。

PagesとWorkerの変更は原子的ではありません。
停止時間を含むWorker先行の手順として計画し、古いタブやcacheは配信hashと再読込で確認します。

## 復旧

最初の復旧先は、同じOAuth2コードを維持するread-onlyのVersionです。
新規受付を止め、同じ操作キーで状態を照会します。
sendingやunknownを新しいキーで送り直しません。
送信済みのDiscord API呼び出しは取り消せないため、必要ならDiscord側で人が確認します。

DOや投稿署名鍵を削除せず、既存receipt、操作hash、cooldownを保持します。
コードrollbackをデータrollbackとして扱いません。
旧PW認証の本番Versionへ戻さず、新認証とv2状態の互換を確認した候補だけを復旧先にします。
初回OAuth2公開では過去に安全な公開Versionがあるとは仮定しません。
候補read-onlyを保存して、次のtrue反映時の復旧Versionに固定します。

新OAuth2コードへ移行すると、初回DO認証処理で旧sessionsとattemptsを削除します。
旧Bearerは形式でも拒否されます。
フロントは旧sessionだけを削除し、operations.v1を保持します。
Secret追加だけで旧セッション無効化が完了したとは報告しません。

## GOの証拠

本番のGOには、対象Versionとbundleの対応、DO同一性、Secret名と鍵の維持、配信hash、実本人OAuthと非本人拒否、実Embed2件、旧操作照会、対象VersionのCPUと資源制限、停止と復旧の確認が必要です。
このうち未実施の項目はNOT TESTEDとして残します。
ローカルのCPU計測や5秒の通信timeoutを、本番CPU quotaの合格に置換しません。
DNSの実peer IP固定とDiscordが後で取得する画像bytesの同一性は現行方式の保証外として明示します。

## 仕様根拠

コードとSecretsを候補Versionへ同時uploadし、反映を分ける方式は[Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)と[WranglerのWorkerコマンド](https://developers.cloudflare.com/workers/wrangler/commands/workers/)で確認しました。
既存DO migrationの制約は[Durable Object migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)を参照します。
実行前に固定CLIのhelpと仕様を再確認し、未知の差分では停止します。
OAuth2の固定callback、code交換、identifyは[Discord OAuth2](https://docs.discord.com/developers/topics/oauth2)に基づきます。

## 2026-10-16: 稼働中の調査と公開判定の分離

`inspect --expectations <reviewed.json>` を追加した。
期待値の形式と固定GET先はpreflightと同じだが、調査に限ってmode=trueとLogs有効を記録できる。
完全Version/latest/Deployment ID、設定、Secret名、DO等の確認値を2巡して照合する。
出力は必ず `releaseEligible=false`、`productionGo=false`。
prepare/preflightの停止条件は維持し、true基準やLogs有効基準を候補へ流用しない。
未取得のAPI値をUIから推定した値で埋めない。

今回のUI確認では稼働Version `43425306-e017-4b90-ba93-9a70733ce59b`、100%、FORUM_POSTS_ENABLED=true。
Logs有効、起動ログ収集/保存有効、sampling100%、Traces無効を確認した。
新OAuth2 Secret5名は一覧に無く、既存5名のみ。値は取得していない。
Deployment UUID、APIのlatestVersionとの厳密な区別、全moduleのhash、実効limits/完全metadataはNOT VERIFIED。
従って期待値ファイルを作成せず、live API preflight/inspectは実行していない。

ログ設定は未解決の公開停止条件である。
候補のfalseで現行Logsを無断停止せず、現行trueを無条件許可しない。
OAuth callbackのcode/state/query、Authorization/Cookie、Secret、レスポンス本文を記録しない方針を先にレビューする。
公式仕様のinvocation_logs制御と実際のAPI設定を照合し、ログ維持/変更の具体差分を別承認へ提示する。
UIの「起動ログ」表示だけでAPI metadataのinvocation_logsと同一と断定しない。

## 単発操作と候補読み戻しのローカル準備

`production-release-protocol.cjs` はローカルのプロトコル部品で、live executorではない。
CLI、既定HTTP transport、Token探索、Secret読み取り、upload/deployへの接続は持たない。
本番応答の形式・全module読み戻し手段が未確認なので接続を有効にしない。

- oauthBindings: 新5名だけを受け取り、固定callbackと値の最低条件を検査する。既存鍵の置換を拒否する。値はメモリーだけで扱い、出力/保存しない。安全な対話入力経路の本番接続はNOT TESTED。
- singleAttempt: 操作hashだけを排他的journalに記録しfsyncしてから、注入された送信処理を一度呼ぶ。timeout/例外/成功いずれも再送は禁止。成功応答でも独立した読み戻しまでunknownを維持する。journal削除・別名・別hashで再試行しない。
- verifyCandidate: 完全Version、bundle hash、全設定、Secret名、namespace/class/SQLite/migration/modeのレビュー済み正規化証拠と一致するか検査する。API応答の変換や全module取得を実装済みとは扱わない。
- switchPayload: 完全UUID一件100%の切替案だけを生成する。送信はしない。

本番接続を追加する前に、実multipartをassertUploadMetadataで検査し、固定Worker endpoint、直前preflight、journalと対象操作の一対一対応、timeout、応答サイズ制限、無retry、エラー本文非露出をレビューする。
通常のwrangler secret putは使用せず、コードと新5Secretを同一の停止候補へ束ね、既存Secretをinherit/keepで保持する。
Secret登録・交換、候補upload、切替は今回実行していない。

停止候補と試行候補は同一ソース/DO/Secret/limitsを保持し、modeだけが差分になるよう個別に生成・読み戻しする。
今回true候補のlive生成・検証経路はNOT VERIFIEDなので有効にしていない。
復旧先は確認済みOAuth2 read-only Versionへ固定し、旧PW版へのrollbackやDO削除で代用しない。
停止後もsendingは取り消せず、unknownは同じ操作キーで照会し、Discordを人が確認する。新キーでの再送は禁止。

仕様確認: [SecretsとVersion upload](https://developers.cloudflare.com/workers/configuration/secrets/)、[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)。
2026-10-16にContext7で参照したが、本番API応答・安全性の実測を代替しない。

## 2026-10-28の準備確認

調査開始時の開発HEADとremoteは `538d82396ce7e2f7b22d123cf58b00c45d48b7f4`、mainは `7ad417f37a6ddb9bd9bf9621c651a8dd89b8883a` で一致した。
GitHub Pages APIはmain/root、HTTPS強制、latest build commitも同mainを返した。
公開4assetはすべてHTTP200でmainとバイト一致し、OAuth候補とは不一致だった。

管理画面ではactive Version `43425306-e017-4b90-ba93-9a70733ce59b`、100%、FORUM_POSTS_ENABLED=trueを再確認した。
既存5Secretのみ存在し、新OAuth2の5名は未登録だった。
Logs有効、起動ログ収集と保存有効、sampling100%、Traces無効だった。
AUTH_STATEは既存namespaceのdiscord-event-poster-api_AuthStateを参照し、Bound Worker一致、SQLを確認した。
Discord ApplicationのOAuth2 Redirectは未登録、Client Secretは非表示のまま扱った。
Applicationと稼働Bot Tokenの対応、暗号化されたforum IDとの一致、対象forumの実効権限は未確認である。

管理API用の環境変数が無いため、API latestVersion、Deployment UUID、全module hash、migration metadata、実効Worker/DO limitsは未確認である。
資格情報ファイルの探索やrefresh、Global Keyへのfallbackは行っていない。
画面の最上位VersionをAPI latestとして期待値ファイルへ転記していない。
inspect/preflightの本番実行と停止操作は行っていない。

公式Workers Logs文書はinvocation logにmethodとURLが含まれることと、`observability.logs.invocation_logs=false`で無効化できることを示す。
これは当該本番metadataの確認を代替しない。
次回はLogs全停止を既定にせず、診断ログを維持しながらinvocation logを無効にする案について、完全metadataとtail/Logpush/trace経路を照合し、変更差分を別承認へ提示する。
現在のenabled=false必須ガードを緩めてLogs有効候補を通す変更はしていない。

`verifyRecoveryPair(expectedRecovery,actualRecovery,expectedTrial,actualTrial)`を追加した。
両版の独立した完全読み戻しをそれぞれ照合し、別々の完全UUID、read-only/trueの向き、同一bundle、DO、Secret名、settingsを検査する。
modeとVersion ID以外の差分は拒否する。
これは正規化済み証拠の検査だけで、API adapter、Secret値同一性の証明、本番の復旧成功を実装したものではない。
既存鍵の維持には実upload metadataのinherit検査と変更操作の監査も必要になる。
true候補の生成経路は依然として未接続であり、productionGoはfalseのままである。

本番操作の順序は、旧版受付停止Sを100%反映して確認、Redirect登録と新5Secretを含むOAuth停止候補upload、候補の完全読み戻し、OAuth停止版Rを100%反映、main更新によるPages配信、停止中の認証試験、別承認のtrue版Tと最大2投稿の順とする。
P1前に現行bundleの完全一致と停止版Sの生成方法を確定し、P6前にR/Tの読み戻しとRへの単発切替経路を確定する。
試験終了時はRへ戻し、通常運用は別承認とする。
現時点ではS/R/Tの完全Version IDを作成しておらず、実行可能性は未検証なので、本番操作はNO-GOである。

Cloudflare通常ログイン中に、UIツールが認証情報を含む一時遷移URLを自動出力した。
その値は再掲せず、リポジトリや証拠ファイルに保存していない。
以後は認証遷移中の画面取得を避けた。
Worker Secretsの値取得、PortalのSecret再生成、設定保存、upload/deploy、main変更、実OAuth、実Discord投稿、削除、プラン変更は行っていない。

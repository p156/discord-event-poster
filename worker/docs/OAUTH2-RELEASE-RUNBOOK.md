# OAuth2公開と復旧の手順

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

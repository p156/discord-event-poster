# Phase 3 Step 6B Stage 1 Preflight

確認日：2026-10-10（日本時間）。
開始時HEADと取得したorigin/main：`6574f277245892313d3d95e808d12cf2b99d2378`。
RCコード：`a8c19be063bcd440bf424a815da78c7bd4fae67d`。
worker/srcとpackage.jsonについて両commit間の差分はない。
今回は読み取りとdry-run、文書更新だけで、本番更新を実行していない。

## 1. 本番設定との差分

| 項目 | 本番情報 | RCローカル | 評価 |
| --- | --- | --- | --- |
| Worker名 | discord-event-poster-api（ユーザー確認） | 同名 | 名前は整合。所属accountの今回独立確認なし |
| 最新Version | f69b5c23-d46e-4cd1-a857-daac6e02eb35（ユーザー確認） | RC Git SHAは上記 | Cloudflare versionとGit SHAは別識別子。直前に再確認する |
| Entrypoint | 本番bundleのローカル元pathは未確認 | worker/src/index.mjs | pathはビルド元の構成。version metadataだけで同じソースとは判断しない |
| Compatibility Date/flags | 未確認 | 2026-04-01、flagsなし | 差異があれば互換影響をレビューする |
| DO Binding | AUTH_STATE（ユーザー確認） | AUTH_STATE | 名前だけではデータ継続を証明しない |
| DO接続先表示名 | discord-event-poster-api_AuthState（ユーザー確認） | 同Workerのclass AuthState | namespace ID、class、SQLite backendは別確認が必要 |
| DO namespace ID | 未確認 | 同Worker/classから解決。新namespaceを指定していない | 名前一致だけで同じIDとは扱わない |
| Migration tag | 未確認 | auth-v1、new_sqlite_classes: AuthState | 本番live tagがauth-v1であることを必須確認 |
| Secret | 必要5件登録済み（ユーザー確認） | 同じ5名称をrequiredに列挙 | 値は一切取得していない |
| Vars | FORUM_POSTS_ENABLED未設定（ユーザー確認）。その他の名前は未確認 | vars未定義 | keep-varsでplain varsを保持し、承認後に投稿flagだけfalseを追加する予定 |
| CPU/契約 | Workers Free（ユーザー確認）、cpu_msは未確認 | limits.cpu_msなし | DOと通常Workerを分けて評価 |
| Routes/workers.dev | 公開URLは既知、管理設定は未確認 | 固定Host discord-event-poster-api.monma5435.workers.dev、routes/workers_dev明示なし | custom domains、route、workers.dev有効状態を直前確認 |
| Observability/preview | 本番設定未確認 | observability.enabled=false、ローカル差分にpreview_urls=false | デプロイすると反映され得る。維持できるか先に比較する |
| Git連携/自動deploy | 未確認 | 独自GitHub workflowなし（Step 6A） | Cloudflare Buildsの不存在の証明にはならない |

必要5SecretはALLOWED_ORIGIN、DISCORD_BOT_TOKEN、DISCORD_FORUM_CHANNEL_ID、APP_PASSWORD_HASH、SESSION_SIGNING_KEY。
Discord BotのAdministrator付与と実投稿未実施もユーザー確認情報として受領した。
今回Botへ接続したり権限を再確認したりしていない。
Administratorの申告は実投稿成功の証拠ではなく、Stage 1でDiscord書き込みを許可する理由にもならない。

## 2. 今回確認できた項目

- 最新main取得とRCとのworker/src/package.json差分なし。
- 既存ローカル設定、Binding/class、migration定義、投稿flag未設定、cpu_ms未指定。
- PBKDF2-SHA256 600,000回の計算場所はAuthState.handleのlogin処理。passwordHashは純JS pbkdf2Asyncを使う。
- 同singleton名personal-auth-v1と既存AuthStateを継続するコード。
- インストール済みWrangler 4.149.0のdeployオプション、Migration選択処理、strict検査処理。
- 設定を値なし専用ファイルへ切り離したdry-run成功。

この環境のwhoamiはexit 1、authenticationUsable=false。
ユーザーWindows PCでの認証成功を、この環境での認証成功に置き換えない。
今回新規ログイン、仮アカウント、管理API credentialの取得、Secret値の読み取りを行っていない。

## 3. 未確認事項とユーザー側の読み取り手順

管理認証が使えるユーザーPCで、repoルートから次のGET系コマンドを実行できる。
deploy、versions upload、secret put、wrangler initは実行しない。
deployments listは最新Versionが申告値のままか確認するためのもの。
Authorやaccount情報を含む生出力全体はチャットへ貼らず、必要なmetadataだけ共有する。

```powershell
npx wrangler deployments list --config worker/wrangler.jsonc --name discord-event-poster-api

# version取得は読み取りのみ。JSON全体を表示せず、下で必要項目だけ選ぶ。
$stage1VersionJson = & npx wrangler versions view f69b5c23-d46e-4cd1-a857-daac6e02eb35 --config worker/wrangler.jsonc --name discord-event-poster-api --json
if ($LASTEXITCODE -ne 0) { throw 'Version metadataを取得できません。ここで停止してください。' }
$stage1Version = ($stage1VersionJson -join "`n") | ConvertFrom-Json
$stage1Runtime = $stage1Version.resources.script_runtime
$stage1Bindings = $stage1Version.resources.bindings
if ($null -eq $stage1Bindings -or $stage1Bindings -isnot [array]) { throw 'Binding形式を確認できません。生JSONを共有せず管理画面で確認してください。' }
[pscustomobject]@{
  versionId = $stage1Version.id
  compatibilityDate = $stage1Runtime.compatibility_date
  compatibilityFlags = $stage1Runtime.compatibility_flags
  migrationTag = $stage1Runtime.migration_tag
  limits = $stage1Runtime.limits
  durableObjects = @($stage1Bindings | Where-Object type -eq 'durable_object_namespace' | Select-Object name,class_name,script_name,environment,namespace_id)
  secretNames = @($stage1Bindings | Where-Object type -eq 'secret_text' | Select-Object -ExpandProperty name)
  bindingNamesAndTypes = @($stage1Bindings | Select-Object name,type)
} | ConvertTo-Json -Depth 6
```

このサンプルはローカルWranglerのversions view実装とversion APIのmetadata形式を確認して作成したが、本番データでは未実行。
値のフィールドtext/value、作者メール、注釈、生JSONを出力しない。
最新versionが変わっていれば、指定IDを勝手に旧版へ固定せず、新しいIDを対象にし直して結果を再レビューする。
namespace_idやmigration_tagが省略された場合は一致と判断せず未確認を維持する。
versionのtagと現在live serviceのtagが一致するかも管理画面の現行deploymentで確認する。

次は管理画面の読み取りで確認する。設定画面を開いても保存しない。

1. AUTH_STATEのclass、namespace ID、所属script/accountとSQLite backend。接続先の表示名だけで完了にしない。
2. 現行live migration tagと適用履歴。auth-v1であること。取得できなければここで止める。
3. 全Bindingの名前とtype。RCにない既存Bindingがあれば削除リスクをレビューする。
4. varsの名前、投稿flag未設定、cpu_ms、observability、preview_urls、routes、custom domains、workers.dev。
5. Builds/Git連携の有無、対象branchとroot、deploy command、監査文書pushが自動deployを起こす設定か。

Secretの「表示」「Reveal」、コードや設定全体のダウンロードは行わない。
Migration履歴を取得できる安全な管理手段がなければ、推測でauth-v1と確定しない。
自動deployが存在する場合は、手動更新との競合防止を別承認で確定する。

## 4. Freeプラン適合性

Workers FreeのHTTP CPU上限は10ms、SQLite Durable Objectは既定30秒のCPU制限として公式に記載される。
Freeで利用できるDO backendはSQLiteのみ。
RCのnew_sqlite_classesはこの前提に合うが、本番のbackendは今回独立確認できていない。[Workers制限](https://developers.cloudflare.com/workers/platform/limits/)、[DO制限](https://developers.cloudflare.com/durable-objects/platform/limits/)

600,000回PBKDF2はDO内で実行するため、外側Workerの10msへその全計算を置いている実装ではない。
ただし外側にもJSON、hash、HMAC、応答処理があり、本番で10msを超えない保証はない。
DOのCPU、alarmの清掃負荷、storage quotaも本番で評価する必要がある。
ネットワーク/storage待機のwall timeとCPU timeは別であり、ローカルPASSや処理時間だけを本番CPUの証拠にしない。

RC設定にPaid向けcpu_ms増加、KV backend、Containers等はない。
Free利用に明確な設定矛盾をローカル側では確認していない。
cpu_msを300000等へ引き上げる変更、課金plan変更、反復回数引き下げは今回行わず、必要なら別途判断する。
APP_PASSWORD_HASH形式とSESSION_SIGNING_KEYは互換維持し、再生成は不要。

Stage 1更新後に既存認証とtagsのCPU/Invocation Status、1102やexceededCpuの有無を確認する。
Secret、password、Authorization、Cookie、本文、例外全文をログへ出さない。
計測のためにobservability設定変更が必要なら別承認を得る。
投稿経路の本番CPUと実receiptはStage 3の承認済み試験へ残す。

## 5. デプロイコマンドの安全性評価

Step 6Aのコマンドは条件付きの候補であり、未確認の本番設定へそのまま実行して安全とは判定しない。
`--keep-vars`が保持するのはplain vars。DO binding、routes、observability、preview、CPU設定全体を保全するオプションではない。
Secretは通常deployで削除されないが、Secret添付やsecret操作は行わない。
`--var "FORUM_POSTS_ENABLED:false"`は文字列falseを明示し、keep-varsで保持する本番設定に対して投稿flagだけを上書きする。[Wrangler公式deploy仕様](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)

strictは特に非対話環境でremote設定上書きの確認を拒否する防御で、全設定一致やnamespace不変を証明しない。
Wrangler 4.149.0のpreUploadApiChecksでは、dashboard由来の最終deployに対するremote差分検査等を行う。
この検査の対象条件外の差異、Migration、新しい同時更新まで防ぐ万能なロックではない。
対話環境では確認promptを誤って承諾できるため、計画を非対話実行＋strictへ補強する。
既存設定をremoteへ自動patchするpromptも承諾しない。

以下は**全事前条件の解消とStage 1実行承認後だけ**の修正案。
今回実行していない。repoルートで固定Wrangler版を用いる。

```powershell
$stage1PreviousCI = $env:CI
try {
  $env:CI = 'true'
  npx --no-install wrangler deploy --config worker/wrangler.jsonc --name discord-event-poster-api --keep-vars --var "FORUM_POSTS_ENABLED:false" --strict
  if ($LASTEXITCODE -ne 0) { throw '更新が停止しました。強制実行せず原因を確認してください。' }
} finally {
  if ($null -eq $stage1PreviousCI) { Remove-Item Env:CI -ErrorAction SilentlyContinue }
  else { $env:CI = $stage1PreviousCI }
}
```

使用する設定のobservability/preview/routes/compatibility/bindingsが本番と違う場合は、この案も保留する。
元のWrangler差分を壊さず、別の監査済みデプロイ専用設定で本番値を保全する方法を別途承認する。
Secret値をその専用設定へ書かない。
現行versionが申告値から変わった場合やstrictが止めた場合、--strict削除、--force、別namespaceへの切替で回避しない。
DO code更新がdeferredの場合は反映完了を待ち、outer WorkerのversionだけでDO更新完了と判断しない。

## 6. Durable Object保護方針

同account、同Worker、同class AuthState、同namespace ID、SQLite、同singleton personal-auth-v1を保持する。
RCへ既存storageのsessions/attemptsと用途別posts/rate/cooldown keyを継続し、新DOへの置換はしない。
Binding名一致、namespace表示名一致、初期migrationがGitにあることだけでは十分ではない。

Wrangler 4.149.0のgetMigrationsToUploadを確認した。
live migration tagがローカル最後のauth-v1と一致する場合、新Migrationを送らない。
live tag未設定の場合は全ローカルMigrationを送信対象にし、不一致tagの場合もwarningの後に全Migrationが対象になる経路がある。
dry-runではlive migration検査を省略するため、dry-run成功でこのリスクを排除できない。[公式SDK実装](https://github.com/cloudflare/workers-sdk/blob/main/packages/deploy-helpers/src/deploy/helpers/durable.ts)

本番tagがauth-v1、namespace IDとbackendが保持対象に一致することを、実行前に必須確認する。
auth-v1以外、空、取得不可、追加Binding、移転/rename/deleteの要求は中止条件。
Migrationを消してwarningを避けたり、namespace IDを推測で書き換えたりしない。
既存認証と投稿履歴の削除や初期化も行わない。

## 7. SecretとVarsの保護方針

5Secret登録済みはユーザー確認情報として採用し、値の取得や再設定は不要。
デプロイ専用設定やCLIへBot Token、パスワードhash、署名鍵を渡さない。
--secrets-file、secret put/bulk/delete、.dev.vars/.env読取を用いない。
keep-varsと明示falseを組み合わせ、その他plain varsを消さない。
全Binding一覧を比較し、RCに記載のない既存非vars Bindingがあれば更新を停止する。
Secretが維持されてもnamespaceやOrigin/Hostの変更で認証を壊さないよう、Stage 1後に回帰確認する。

## 8. Dry-run結果

値なしのignored専用設定worker/work/step5-dry-run/wrangler.jsoncを使用した。
元設定と同じWorker/class/tag/compatibility/Secret名で、mainは参照先を合わせる相対pathだけが異なる。
専用ディレクトリにSecretファイルはなく、dotenv自動読取を無効にした。
keep-vars、明示false、strict付きdry-runはexit 0、85.21 KiB / gzip 21.46 KiB。
AUTH_STATEとFORUM_POSTS_ENABLEDのbindingが表示された。

```text
npx wrangler deploy --dry-run --config worker/work/step5-dry-run/wrangler.jsonc --outdir worker/work/stage1-preflight-bundle --keep-vars --var "FORUM_POSTS_ENABLED:false" --strict
```

この実行はuploadなし。
本番settings、namespace ID、migration tag、Secret名、CPU、routes一致の証明ではない。
ビルド証跡はignoredでcommitしない。
文書内のPowerShell 2ブロックは構文解析エラー0。管理API取得やdeployを実行した検証ではない。
version確認時のsandbox内診断ログ書込EPERMは、sandbox外での版確認により解消した。dry-runの失敗ではない。

## 9. Stage 1の中止条件と更新後確認

namespace ID/class/backend/live migration tagを確認できない間は実更新を開始しない。
本番とのcompatibility/observability/preview/routes差異、未知Binding削除、Git自動deploy競合があれば再レビューする。
Freeで非対応のCPU設定、管理account不一致、最新version変化、strict停止、Migration適用要求は実行を止める。

承認後のStage 1更新では投稿APIをfalseに保ち、最初に正当Originのpreflightと状態GETで404を確認する。
その後に承認範囲内で投稿POST/intent POSTの404、capabilities.forumPosts=false、forumPostStatus=falseを確認する。
新規操作やDiscord送信は発生させない。
既存パスワードでのログイン、session、logout、固定forumのtags、namespace IDの維持、CPUを確認する。
認証失敗、別forum、保存障害、Secret不足、投稿有効、1102/CPU超過の場合はStage 2へ進まない。
投稿機能を有効にする変更やDiscord実投稿は別承認まで行わない。

## 10. 最終判定

**READY WITH CONDITIONS**。
ローカルに重大なFree設定矛盾はなく、RCビルドは成功。
本番情報の残件には、ユーザーPCでの安全なGETと管理画面確認の解消手順がある。
DOの実namespace ID、SQLite backend、live migration tag、全Binding、compatibility、routes、observability、preview、Git連携が未確認のためREADY TO DEPLOYではない。
既存データを破壊する不一致を確認したわけではないため、現段階でBLOCKEDとはしない。
残条件が解消しても、Stage 1の実行承認を得るまではデプロイしない。

## 11. 変更ファイルと保全結果

追跡ファイルの変更は本書worker/docs/phase3/STEP6B-STAGE1-PREFLIGHT.mdだけ。
既存Wrangler差分は整形とpreview_urls:falseを含み、変更していない。
.bakは存在し、Secret、.dev.vars、.envとともに追加/commitしない。
設定の開始時SHA256は以下で、完了前も同値を確認した。

```text
wrangler.jsonc: D4D5326B330B36950FD47320E246E46C9A9A27626055614053A77445B620505F
wrangler.jsonc.bak: 7F28CAB37EACF66ED31162FF08640D74B18878B9B3CFF75EBB278286F925723F
```

## 12. Commit SHA

本書初版のcommit/push確認後に確定値を追記する。
自己参照を避け、結果追記だけのcommitは最終報告で区別する。

# Stage 1のWrangler限定修正検証

検証日：2026-10-10（日本時間）。
対象：p156/discord-event-poster、Wrangler 4.149.0。
[前回の調査](STEP6B-STAGE1-STRICT-INVESTIGATION.md)を確認して実施した。
本番デプロイ、strict解除、本番設定やSecret変更、DO Migration、Discord実投稿は行っていない。

## 1. 判定と採用候補

**ローカル検証PASS。Stage 1再実行は承認待ち（READY WITH CONDITIONS）。**
公式の公開済み修正版は調査範囲で確認できなかった。
採用候補は、原版4.149.0を変更せず、比較関数だけをメモリー上で正規化する局所修正版。
これはCloudflare公式修正版ではなく、本リポジトリ用の監査可能な検証候補である。
検証用CLIは実uploadを拒否する。現状のまま本番deployに使うことはできない。
本番用の実行方法を確定して別途承認を得るまで、停止状態を維持する。

## 2. 受領した本番情報

ユーザー確認情報として、Version a9901f55-6b22-4a67-8ce6-4c2dca5e4e3d、namespace ID 5157fbc20842458f8e8269b821e51f47、class AuthState、migration tag auth-v1を受領した。
script_nameとenvironmentはいずれも項目なしという確認結果も受領した。
これは前回のfalse positive再現条件と整合する。
今回、この環境から本番管理APIを取得し直したわけではない。

## 3. 公式修正版の調査

公式npm metadataのdist-tagsを取得し、latest=4.149.0、legacy=3.114.17を確認した。
公開version一覧の末尾も4.149.0で、それより新しい公開版は確認できなかった。
公式GitHubの最新releaseはwrangler@4.149.0、公開日時2026-10-08T18:33:04Z。
変更履歴には今回のDO optional項目比較の修正を確認できなかった。
実際の原版bundleでは、同じ空Binding差分を再現した。

公式mainのmetadata mapperでもscript_nameとenvironmentを無条件に生成する記述を確認した。
比較処理の最近の履歴ではcustom domain等の変更を確認したが、このDO不具合の修正と同一視しない。
未公開mainからCLIをビルドしたり、未知の最新版へpackageを更新したりしていない。
「過去の全versionや全PRを網羅して不存在を証明した」とは扱わず、現行公開版で修正版を確認できなかったという結論に限定する。

参照：[公式4.149.0 release](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.149.0)、[公式npm metadata](https://registry.npmjs.org/wrangler/latest)、[公式mapper](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-utils/src/map-worker-metadata-bindings.ts)。
Context7で公式SDK資料も調べたが、直接の修正情報を得られなかったため、registry、公式release、インストール済み版の実装を根拠にした。

## 4. 修正範囲

worker/tools/wrangler-strict-candidate.cjsは、インストール済みWranglerのbundleを読み取り、既知SHA256と挿入位置の一致を確認する。
一致しなければ停止する。
getRemoteConfigDiffで正規化済みlocal/remoteを比較する直前に、次の処理を1箇所だけ挿入する。

1. durable_objects.bindingsの比較用コピーを作る。
2. script_nameとenvironmentについて、値がundefinedの場合だけpropertyを除く。
3. name/class、値のあるoptional項目、他のBindingや設定は変更しない。
4. 元のdiffJsonObjects、isNonDestructive、strict拒否処理へ渡す。

metadata mapper、入力config、upload metadataを変更する修正ではない。
比較による副作用を避け、元のlocal/remoteオブジェクトも変更しない。
元node_modulesのファイルは書き換えない。
依存とpackage/lockの更新も行わない。

```text
原版bundle SHA256:
31866B9A3686777254819158E60EBE4920D1D91141CDE68846C62B52F75D7A66

比較修正挿入後のメモリー上source SHA256（CLI呼び出し用exportを追加する前）:
AB880E186360BA70DA335C8FA1A3C01B782984A51778C19152410A2B504C4C76
```

CLI主処理は隔離したNode moduleから呼び出す。
主処理を呼ぶためのexport追加と外側の検証ガードは、上記比較修正とは別の起動用interface。
元Wranglerの他の処理本体を変更したものではない。

## 5. 検証専用ガード

候補CLIはversion表示と、指定された値なしconfigでのdry-runだけを許可する。
deploy時はdry-run、strict、keep-vars、FORUM_POSTS_ENABLED:falseを必須とし、重複指定、false上書き、未知オプションを拒否する。
configとoutdirは専用のworker/work/wrangler-strict-validation配下へ固定する。
configの全内容も、既存Worker/class/tag、Secret名だけを持つ期待値と照合する。
--secrets-file、secret put、別config、投稿flag true、非dry-runを拒否する。
dotenv自動読取とmetrics送信を無効にし、CI環境でstrictを維持する。

このガードは誤操作防止であり、任意のJavaScriptを書き換えて実行する人まで制限するセキュリティ境界ではない。
本番実行のために黙ってガードを外すことはしない。

## 6. 正常系と異常系の試験

`node --test worker/tests/wrangler-strict-candidate.test.cjs`：**12/12 PASS、失敗0**。
試験は実際の原版とメモリー上修正版の関数を使い、API metadataはモックとする。
本番Secret値は使わない。

| 試験 | 結果 |
| --- | --- |
| 原版の空Binding false conflict | 再現、nonDestructive=false |
| 同じBinding、optional項目なし | 修正候補ではdiff=null |
| 修正は1箇所の挿入だけ | 挿入を取り除くと全sourceが原版と一致 |
| 基底source不一致 | 候補生成を拒否 |
| 元local/remoteへの副作用 | 変更なし |
| 実際のBinding name/class/script/environment変更とBinding削除 | nonDestructive=falseを維持 |
| null、空文字、false、0のoptional値 | undefinedとして除去せず差分を維持 |
| 同じ明示script/environment | diff=null。異なる値では拒否 |
| 非DO serviceとobservability差分 | 拒否を維持 |
| 実Wranglerのstrict継続確認 | CIでfalseを返して拒否 |
| auth-v1と未設定tagのMigration生成 | 原版と候補が同じ結果 |
| upload metadata | 原版と候補でJSON文字列が完全一致 |
| CLIガード | 非dry-run、strict解除、Secret添付、別config、投稿有効化等を拒否 |
| 実候補プロセスで非dry-run指定 | CLIロード前にexit 1。upload処理を呼ばない |

strict拒否試験では、Wranglerが出すAbortingのERROR表示は期待どおりの結果。
strictを外して再実行したという意味ではない。
比較元Wranglerが持つ「安全な追加をnon-destructiveとする」判定を全面拒否へ変更するなど、別の仕様変更は行っていない。
ここでの実Binding変更拒否は、既存Bindingの接続先変更や削除等について検証したもの。

## 7. Migration、upload、Secret、投稿処理への影響

getMigrationsToUploadを実関数のまま、metadata GETだけモックして呼び出した。
live tag=auth-v1では原版と候補ともMigration生成なし。
live tag未設定では両方とも同じMigration候補を生成した。
後者は安全な本番条件ではないため、再実行前にlive tag一致を確認して止める運用を維持する。
修正はMigration処理に入っていない。

createWorkerUploadFormの実関数で生成したmetadata文字列は完全一致した。
AUTH_STATE/AuthState、FORUM_POSTS_ENABLED:false、keep_bindingsのplain_text/json/secret_text/secret_keyを確認した。
Secret保持試験はTEST_ONLYの架空値だけを使い、値を試験出力へ表示していない。
実Secret、保存namespaceや履歴を読み書きした検証ではない。

Workerへのimportや投稿経路には候補CLIを接続していない。
候補と原版の生成Worker bundleも完全一致した。
よってCLI比較の修正によるproductionコード変更はない。
実namespace IDはこの比較では検証されないという元の制約も残り、独立照合が必要。

## 8. Dry-run

候補CLI実行：PASS、exit 0、85.21 KiB / gzip 21.46 KiB。
原版4.149.0でも同じ値なしconfigとflagでdry-runを実行してPASSした。
両方にAUTH_STATEとFORUM_POSTS_ENABLEDのbindingが表示された。
configには必要Secret名だけを含め、値は含まない。
元worker/wrangler.jsoncは使用も変更もしていない。

```powershell
node worker/tools/wrangler-strict-candidate.cjs deploy --dry-run --strict --keep-vars --config worker/work/wrangler-strict-validation/wrangler.jsonc --outdir worker/work/wrangler-strict-validation/candidate-bundle --var "FORUM_POSTS_ENABLED:false"
```

元CLIがoutdirをconfig基準でも解決するため、候補起動時にconfig/outdirを絶対pathへ解決する。
初回のhash確認は生成物の位置を誤認して失敗したが、絶対pathで再生成して照合した。
初回のmetadata試験も、fixtureを配列からWrangler内部のBinding map形式へ直した後、全試験を再実行してPASSした。
候補を正当化するために期待結果を弱めたものではない。

```text
original-bundle/index.js SHA256:
4A72117E4287B76910C39F1EA95876A02CF4D80AD8DB84BBFC1D61918C5811D0

candidate-bundle/index.js SHA256:
4A72117E4287B76910C39F1EA95876A02CF4D80AD8DB84BBFC1D61918C5811D0
```

dry-runはremote比較、live migration取得、実権限確認を省略する。
したがってこのPASSだけで、本番strictが通ることやnamespace保持を証明したとは扱わない。
uploadや新version発行は行っていない。

## 9. 既存機能の回帰

| コマンド | 結果 |
| --- | --- |
| npm test | パーサーPASS、Node 113/113 PASS |
| npm run test:worker-runtime | PASS。production PBKDF2 cap再現、600,000回、SQLite DO、session、logout |
| npm run test:post-runtime | PASS。同キー並列、共有10枠、永続化、再起動、read-only、unknown再送禁止、429 |
| node --check（候補CLI/追加試験） | PASS |

Discord通信はモック。ログインのローカルwall timeを本番CPU証拠として使わない。
今回ブラウザ全回帰を再実行したとは記録しない。
新試験12件は独立コマンドで実行し、npm testへの追加やpackage変更は行っていない。

## 10. Stage 1再実行条件

ユーザーが確認したnamespace/class/tagとoptional項目欠落は、今回の修正前提に整合する。
ただし以下の条件を満たすまでは本番を更新しない。

1. 最新live Version、同account/Worker、namespace ID 5157fbc20842458f8e8269b821e51f47、AuthState、SQLite、auth-v1を直前に再確認する。
2. 同singleton personal-auth-v1、既存5Secret、その他Binding、routes、observability、preview、Git連携の保全を維持する。
3. 候補の単一修正差分とhash、実デプロイ用の起動方法をレビューして別承認する。
4. 実行時もCI＋strict、keep-vars、FORUM_POSTS_ENABLED:falseを維持し、unknownな差分やMigration要求が出たら停止する。
5. 更新後は投稿API 404、認証、tags、namespace ID、既存データ、CPUを確認し、投稿有効化へ自動で進まない。

検証専用CLIの実upload拒否を解除する変更や別起動方法を、今回の承認に含めない。
原版のstrictを外す再実行、設定へ空文字/nullを埋める回避、BindingやMigration削除は行わない。
本番APIのversion表現とstrictが読むservice metadataの表現差、並行deploy、CPU使用量は残存リスク。
これらは今回のlocal PASSだけでは排除できない。

## 11. 変更ファイルと保全

新しい追跡候補ファイルは次の3件。

- worker/tools/wrangler-strict-candidate.cjs（検証専用CLI）
- worker/tests/wrangler-strict-candidate.test.cjs（12試験）
- worker/docs/phase3/STEP6B-STAGE1-WRANGLER-VALIDATION.md（本書）

値なしconfigとbundleはignoredのworker/work/wrangler-strict-validation配下に作成した。
これらは本番設定やGit追加対象ではない。
Worker/frontendコード、package/lock、インストール済みWranglerに変更なし。
元Wrangler差分と.bakも保持し、開始前後でSHA256が一致した。

```text
worker/wrangler.jsonc:
D4D5326B330B36950FD47320E246E46C9A9A27626055614053A77445B620505F

worker/wrangler.jsonc.bak:
7F28CAB37EACF66ED31162FF08640D74B18878B9B3CFF75EBB278286F925723F

node_modules/wrangler/wrangler-dist/cli.js:
31866B9A3686777254819158E60EBE4920D1D91141CDE68846C62B52F75D7A66
```

今回の依頼にはcommit/push指示がないため、成果物はローカル保存のみ。
検証は完了したが、本番実行はせず、次の承認を待つ。

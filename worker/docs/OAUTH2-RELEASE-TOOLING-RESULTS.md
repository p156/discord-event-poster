# OAuth2公開前ツールの整備結果

日付は2026-10-13 JSTです。
対象は `event-poster-v2`、開始HEADは `fb582c89c7588dc99125d0438648e21ca67b7a63` です。
ユーザーが承認した範囲は、OAuth2対応の公開手順、復旧手順、検証ツールの整備です。
本番公開の承認は含みません。

## 結果

**ローカル整備はPASS、本番公開は引き続きNO-GOです。**
旧Stage 1の固定configに依存する検証経路を使わず、OAuth2用の読み取り専用gateを追加しました。
アプリのOAuth2、画像、投稿ロジック、正規Wrangler設定は変更していません。
旧公開ガードの安全検査を削除したり、旧8失敗を成功に置換したりしていません。
旧ツールとテストは履歴として保持します。

新gateにはcloud writeの実行経路がありません。
本番用の単発uploadと切り替え経路への接続、実candidate Versionの検査、本番の停止と復旧はNOT TESTEDです。
G1については公開準備のローカル検証経路と手順を整備した段階であり、本番移行が検証済みになったとは判定しません。

## 変更したもの

| ファイル | 役割 |
| --- | --- |
| worker/tools/oauth2-release-gate.cjs | 候補作成、再構築照合、GET限定preflight、実upload metadataの検査関数 |
| worker/tests/oauth2-release-gate.test.cjs | 固定対象、停止条件、改ざん、実Wrangler form、timeoutの19検査 |
| worker/docs/OAUTH2-RELEASE-RUNBOOK.md | 実行方法、本番基準、承認、公開順序、Secret継承、復旧と残課題 |
| worker/docs/OAUTH2-RELEASE-TOOLING-RESULTS.md | この結果報告 |
| package.json | test:release-gateとrelease:gateを追加。依存の変更なし |
| README.md | 新gateと手順書への入口を追加 |

## 安全境界

prepareはrepo、branch、明示SHA、originを確認します。
bundle、設定、ソースファイル、ツールのハッシュを固定し、verifyでソースから再構築して照合します。
出力は無視対象の `work/oauth2-release/` の子ディレクトリだけです。
既存候補を上書きせず、symlink経由の書き込みも拒否します。
アプリソースの変更や依存の変更を候補作成中に見つけた場合は停止します。

preflightは確認済みの期待値を必要とします。
Account IDやVersionを推測せず、期待値が不完全ならGET前に停止します。
固定production環境、最新と稼働Version、deploymentの100%、DOのnamespaceとSQLite、migration、全Secret名、投稿停止mode、既存limits、routes、domains、schedule、公開previewを照合します。
未知のトップレベル設定、差分、権限エラー、redirect、timeoutでは停止します。
Secret値やAPI応答本文を診断に返しません。

各GETは1回で、資格情報のrefreshや自動再試行を行いません。
応答は1MiBと10秒までです。
2巡の全snapshotを比較し、同じ検査中のVersionや設定変更も検出します。
この検査は本番設定をロックしないため、公開直前の再検査を別に必要とします。

候補はread-onlyで、旧認証へ戻るfallbackは追加していません。
基準付き候補では既存CPU上限とsubrequest上限を明示的に引き継ぎます。
基準なし候補をそのまま本番用preflightに通すことはできません。
新9必須名の未設定も、移行前基準では隠さず `oauthSecretNamesPresent=false` とします。
`productionGo` は常に `false` です。

## 今回実施した検証

| 検証 | 結果 |
| --- | --- |
| npm run test:release-gate | PASS 19 / FAIL 0 |
| npm test | PASS 141 / FAIL 0 |
| 新gateのprepareとverify | PASS |
| 固定Wrangler 4.149.0のversions upload --dry-run --no-bundle --strict --keep-vars | PASS、uploadなし |
| 作成した候補bundleを使うworkerdとSQLite | PASS。mock OAuth、旧認証拒否、停止capability、投稿と画像ルート404、logout失効 |
| 実Wrangler form builderのmetadata | PASS。旧4必須Secretはinherit、新5OAuth Secretは同じpacket、keep_bindings維持、DO維持、read-onlyとlimits一致 |
| git diff --check | PASS |
| Workerソース、正規config、依存lock、フロントの差分 | なし |
| 本番preflight、本番Version照合、Portal、実OAuth、実Embed、CPU quota | NOT TESTED |

Cloudflare APIのfixture、Discord APIのfixtureにはテスト値だけを使用しました。
実通信へfallbackしません。
workerdは前回判明したローカル接続制限を避けるため、承認された隔離外のローカル実行で確認しました。
本番へのPOST、PUT、PATCH、DELETEは行っていません。

## 固定したローカル成果物

候補は `work/oauth2-release/tooling-ready-20261013/` です。
bundle SHA-256は `d857e16d07c6181b6e7c612a55a04bd7aa3ee3b7c55c14237acbe762c9a45bef` です。
設定SHA-256は `11df3bda8dce7063bff38585f63e3b5bf67852e92f8c218be70ef4faf826582b` です。
dry-runの総upload見積は101.23 KiB、gzipは23.67 KiBでした。

この候補は `remoteBaselineBound=false` です。
本番の期待値を取得していないので、ローカル検証用として固定しています。
本番のCPU設定を引き継いだ成果物とは扱いません。
本番基準をレビューした後、新しい出力先に基準付き候補を作成します。

検証ログは `work/final-gate-20261013/` の `oauth2-` で始まる各ファイルです。
候補runtimeの試験も同じ場所にあります。
いずれもGitとPagesの対象外です。

## 公開前に残る作業

固定Wranglerの内部にuploadの `retryOnAPIFailure` があることをコードで確認しました。
そのため一般のCLIをそのまま無再試行の公開実行経路として推奨しません。
手順書には、承認された単発送信経路で実multipart metadataを検査し、直前の対象確認後に1回送信する条件を記載しています。
この検査関数をcloud writeへ接続することは今回行っていません。

本番のAccount、active Version、最新Version、DO、Secret名、effective limits、Pagesの設定は読み取り未実施です。
Portalと新Secretの準備、実本人OAuthと非本人拒否、画像付きと画像なしEmbed、本番CPU、停止と復旧も別の承認対象です。
承認時には対象Version、投稿内容、件数、停止時間、復旧先を具体化します。
「mainに上げる」の承認を得る前に、これらの未確認項目を解消または承認された移行試験の項目として固定します。

コミット、Push、mainマージ、Pages公開、Worker公開、Secrets変更、Portal変更、実Discord投稿は今回行っていません。

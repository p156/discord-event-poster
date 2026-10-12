# ステージング成果物とローカル検証

2026-10-13 JST。p156/discord-event-poster、event-poster-v2。
基準SHA：61eaf3d4b1de3169bbb8c82a4118aef07df4f97a。
親workspaceのSTAGING-CONSTRUCTION-PLAN-20261013.mdに基づく段階1のローカル実装。

## 実装範囲

本番のWorkerソース、Host、静的4資産、CSP、wrangler.jsonc、公開ガード、依存とlockは変更しない。
staging-artifacts.cjsが基準SHAとのGit blob一致（Windows改行変換を考慮）、repo、branch、originを確認し、ビルド時だけHostとOAuth設定検査を変更する。
ステージングHostを本番allowlistに加えない。
固定のWeb Origin、callback URI、Application ID、forum IDを完全一致で検査する。
CLI、環境変数、リクエストから任意Hostを指定できない。

成果物はwork/staging/の子に排他的に生成する。
worker/index.mjs、worker/wrangler.json、web/内のindex.html、app.js、poster-client.js、styles.cssとmanifest.jsonのみ。
配信対象はweb/だけ。workerやmanifestを含む親ディレクトリを配信しない。
manifestには基準／生成元SHA、ソースhash、bundle／config／4資産hash、許可差分、ツールhashを保存する。
verifyは再構築し、hash、manifest、ファイル集合を照合する。余計なファイル、改ざん、symlinkを拒否する。

固定対象はstaging-local、discord-event-poster-api-staging、予約ドメイン.invalidとテスト専用IDである。
deployable=false、constructionGo=false、productionGo=false。
cpu_ms=10はローカルfixtureであり、本番effective limits確認済みという意味ではない。
実URL、ID、limitsを扱うには、対象を別途承認し、固定定数をレビューして変更し、再検証する。
このツールは実デプロイの承認チェックや実行経路を持たない。

## 混在と復旧の検査

secretsは全9名を厳密検査し、本番比較値がない場合は拒否する。
同じ許可ユーザーIDは認めるが、他のSecret値の流用、署名鍵の役割をまたぐ流用、鍵同士の一致を拒否する。
値はメモリーで比較し、保存、ログ、fingerprint出力は行わない。
実Secretの独立性を今回確認したという意味ではない。実値は取得していない。

initialMetadataは初期作成用の検査関数で、9Secretの明示登録、SQLite auth-v1、read-only、previewを含めない固定metadata契約、limitsを確認する。
inherit、cross-script binding、既存namespace指定は拒否する。
Cloudflareの実初回作成APIとの接続・metadata対応は未検証であり、この契約を直接送信しない。

snapshotは固定環境とWorker、Account指紋、明示Version、bundle hash、DO、SQLite、migration、Secret名、mode、routes、preview、limitsを期待値と照合する。
本番DO namespace、Application、Bot、guild、forumとの一致を拒否する。
同一アカウント案は許すためAccount指紋の不一致を必須とはしていない。
candidateは渡された候補code bytesとmetadataを照合する。実Versionの取得や結び付けは未接続。
mockTransitionはoffline-mockの注入adapterだけを使い、2巡安定確認、明示Version 100%、切り替え後照合を行う。
変更、不明応答、例外で停止し、再試行しない。latest選択、DO再作成、鍵交換は行わない。
実用公開／復旧executorは公開しない。本番ガードは緩和していない。

## ローカル実行

リポジトリrootから以下を実行する。外部操作は含まない。

```text
node worker/tools/staging-artifacts.cjs prepare work/staging/<新規名>
node worker/tools/staging-artifacts.cjs verify work/staging/<同じ名>
node --test worker/tests/staging-artifacts.test.cjs
node worker/tests/staging-runtime.mjs
npm test
npm run test:release-gate
```

## 検証結果

| 検証 | 結果 |
| --- | --- |
| 既存npm test | PASS 141 / FAIL 0、parserもPASS |
| ステージング追加検査 | PASS 13 / FAIL 0 |
| 生成bundleのworkerd／SQLite | PASS：Host／Origin拒否、投稿・画像停止、旧login拒否、DO認証、OAuth開始303と固定Redirect・identify |
| 本番公開ガード19検査 | cleanコミットで最終再実行する。実装中は未追跡ファイルを安全に拒否し17 PASS / 2 FAIL |
| 実API初期作成、実candidate取得、実停止復旧 | NOT TESTED |
| 実OAuth完了、実画像・投稿、実CPU／heap | NOT TESTED |

runtimeテストはlocalhost接続制約によりsandbox内でEACCESとなった。
sandbox外のローカル実行を使用。Miniflareのproxy Hostを既存runtimeと同じ方式でテストharness内だけ補正した。
テストharnessは外部fetchを常に拒否する。生成bundleには含めない。

## 残課題と承認境界

実URL、専用Cloudflareアカウント／プラン、Pages、Discord Application／Bot／guild／forum、namespace、effective limitsと予算は未確定。
固定対象の承認後に、実API初回作成・namespace生成・candidate code取得の対応を確認し、無再試行の実executorを別途レビューする必要がある。
全9Secretの安全な入力経路、実値の独立性、実Discord権限／タグも未検証。
専用DOだけでは本番旧状態の移行を実証できない。
構築前に対象資源、操作、migration、9Secret、初期read-only Worker／Web配信、費用を具体化して別途明示承認を求める。
実OAuth、投稿有効化、2件の実投稿、停止・復旧はその対象と上限を明示して別途承認する。
構築実行・ステージング検証・本番公開はすべてNO-GOを維持する。
Cloudflare／Discord設定変更、Secret登録、実デプロイ、実投稿、mainマージは行っていない。

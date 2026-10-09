# Stage 1本番実行用ラッパーの準備と検証

検証日：2026-10-10（日本時間）。
開始時mainとorigin/mainは`9c68999b57962ffba23069a995152b6d6a734674`で一致。
既存strict調査文書、Wrangler修正検証文書、検証専用CLIと試験を確認した。
今回はオフラインdry-runとモック試験だけ。本番読み取り照合も実デプロイも行っていない。

## 1. 判定

**準備とローカル検証PASS。本番実行は条件付きの別承認待ち。**
既存の検証専用CLIは変更していない。
別ファイル`worker/tools/wrangler-stage1-deploy.cjs`を追加し、将来の本番実行方法を準備した。
実APIのschemaと現在のlive設定が照合条件に合うことは未検証。
次はユーザーの指示を得て読み取り専用preflightを実施し、その結果提示後に実デプロイを別承認する。
今回の依頼をその承認と見なさない。

## 2. 保護対象

| 項目 | 固定条件 |
| --- | --- |
| Worker | discord-event-poster-api |
| Namespace | 5157fbc20842458f8e8269b821e51f47 |
| Class/backend | AuthState / SQLite |
| Migration | auth-v1 |
| 期待する最新かつactive Version | a9901f55-6b22-4a67-8ce6-4c2dca5e4e3d |
| Singleton | 既存コードのpersonal-auth-v1を変更しない |
| Secret名 | ALLOWED_ORIGIN、DISCORD_BOT_TOKEN、DISCORD_FORUM_CHANNEL_ID、APP_PASSWORD_HASH、SESSION_SIGNING_KEY |
| 投稿flag | 文字列falseだけ |
| account | 実行前にユーザーが確認した32桁account IDを必須入力し、account GETとnamespace所属を照合 |

account IDは資格情報ではないが、今回ユーザーから実値を受領していないため推測していない。
既存セッションや投稿履歴、DOオブジェクトの保存内容は取得しない。
既存namespaceを別namespaceへ置き換える処理はない。

## 3. 分離とSHA256検証

元Wrangler bundleは4.149.0の既知SHA256へ固定する。
一致しない版や未知の挿入位置は停止する。
比較のundefined正規化は、既存検証CLIの読み取り用compiler関数を再利用する。
そのCLIの実デプロイ拒否は解除しない。

新ラッパーではさらに、本番用の拒否ガードをメモリー上に追加する。
これはnode_modulesやWorker sourceを書き換える処理ではない。
既存ローカルWrangler設定は読み取りだけで、内容とSHA256を固定する。
書式だけが違う別checkoutでも無条件に許可せず、再レビューが必要になる。

```text
原版Wrangler bundle:
31866B9A3686777254819158E60EBE4920D1D91141CDE68846C62B52F75D7A66
既存検証専用CLI:
9F3BE8A818F7BAFCE7D4220399D492F6487A110750DB7BDABA98A37C9940DD5A
既存worker/wrangler.jsonc:
D4D5326B330B36950FD47320E246E46C9A9A27626055614053A77445B620505F
既存.bak:
7F28CAB37EACF66ED31162FF08640D74B18878B9B3CFF75EBB278286F925723F
```

## 4. 比較と拒否条件

比較時にscript_nameとenvironmentのundefinedだけを省略と同じ表現へ正規化する。
値のある項目やname/class、namespace IDを別値へ書き換えない。
本番ラッパーでは、比較結果なし、または投稿flagをfalseにする既知の追加だけを許可する。
他の追加や変更もstrict上で破壊的扱いにする。
元Wranglerがnon-destructiveと扱う未知の追加を、ここでは無条件に通さない。

GET照合で、必要5Secret名とAUTH_STATEだけを要求する。
許可するplain varは未設定またはFORUM_POSTS_ENABLED:falseだけ。
未知Binding、別namespace/class、optional参照先の追加、余分なSecret、値を含むSecret metadataは拒否する。
他のplain varsが実際に必要な場合は、ここで停止して保全方法を別レビューする。黙って削除しない。

Migration生成関数には「結果がundefined以外なら停止」のガードを追加する。
live tag=auth-v1では元の生成処理が何も生成しないことを試験した。
tag欠落や不一致を、Migrationの再適用や削除で回避しない。
legacy PUT upload経路も拒否し、既存Workerのversion API経路だけを使う。

## 5. 実行直前の読み取り照合

将来のexecuteではWranglerのpreUpload検査入口で照合し、version POST直前にも再照合する。
読み取りは元Wranglerの認証を利用したGETだけで、アプリSecretの取得APIを呼ばない。
対象は次のmetadata。

- account ID、最新upload Version、active deploymentのVersionと100% traffic。
- default environmentがproductionであること。
- auth-v1、compatibility date 2026-04-01、余分なcompatibility flagsがないこと。
- AUTH_STATE、AuthState、namespace ID、5Secretの名前。
- namespace一覧から同IDを照合し、script/class/use_sqlite=trueを確認。
- routesとcustom domainsが空、workers.dev有効、preview無効。
- observability無効と既知defaultの整合、CPU/placementの追加設定なし、schedulesなし。
- 未知のscript設定項目がないこと。

namespace APIのscript/class/use_sqliteは[公式namespace metadata仕様](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/methods/list/)を参照した。
SDK資料でdeployments/versionsのGET形を確認し、インストール済み4.149.0のservice設定読取を調べて実装した。
実APIでの取得はまだ行っていない。
metadata省略やschema違いを、既知の値へ補って通すことはしない。

読取の前後で最新Versionとdeployment IDを再確認する。
GET失敗、Version変更、traffic分割、namespace不一致は書き込み前に停止する。
個々の読取には10秒timeoutを指定する。
namespaceは先頭100件から対象を確認する設計で、見つからなければ停止する。別IDを推測したりobjectを作ったりしない。

## 6. Upload metadataの保護

原版のupload builder自体は変更せず、返すformのmetadataを読み取り検査する。
dry-runでも同じ検査を通す。
必要5Secretはtype:inheritの名前だけで引き継ぎ、Secret値はpayloadに付けない。
Secretやvars保持のkeep_bindings、AUTH_STATE/AuthState、投稿flag falseを照合する。
Migration、exports、未知のmetadata、Binding変更、Secret値添付は拒否する。
原版が付けるpackage依存metadataは、既存package.jsonの固定版と一致するものだけを許可する。

原版とガード付き実builderが生成するmetadata文字列は、モックで完全一致した。
5Secretのinherit指定も実Wranglerの生成関数で確認した。
実Secretを取得して一致試験をしたわけではない。
最初の実version POST以降のdeploy処理は元Wranglerの流れを用いるため、途中失敗を「一切変更なし」と判断しない。

## 7. モードと実行手順案

ラッパーは任意のWrangler引数を受け取らず、strict、keep-vars、FORUM_POSTS_ENABLED:falseを内部で必須設定する。
CI、dotenv自動読取無効、metrics送信無効を子プロセスで設定する。
誤ったmode、重複引数、期待Version違い、account未指定は停止する。
--approvalは操作ミス防止の明示flagであり、人間の承認を自動で証明する認証機構ではない。

### 今回実施したオフラインdry-run

```powershell
node worker/tools/wrangler-stage1-deploy.cjs --dry-run
```

本番account、認証、metadata GETを使わず、ビルドだけを行う。
configにはSecretの名前だけがあり、値は含まない。

### 次の指示後に実施する読み取り専用preflight案

次のコマンドは今回実行していない。
account IDはユーザーが確認した値を使う。資格情報をチャットへ貼らない。

```powershell
$stage1AccountId = '<確認済みaccount IDの32桁hex>'
node worker/tools/wrangler-stage1-deploy.cjs --preflight --account-id $stage1AccountId --expected-version a9901f55-6b22-4a67-8ce6-4c2dca5e4e3d
```

これはGET照合だけで、Wranglerのdeploy主処理を呼ばない。
実schema違いで停止した場合は、必要metadataを値非露出で確認してテストを追加する。
allowlistの全面解除やstrict解除で通さない。

### その結果提示と別承認後だけの実行案

次のコマンドも今回実行していない。

```powershell
node worker/tools/wrangler-stage1-deploy.cjs --execute --account-id $stage1AccountId --expected-version a9901f55-6b22-4a67-8ce6-4c2dca5e4e3d --approval STAGE1-POSTS-OFF
```

事前にCLI、設定、RC source、最新version、Git連携の競合がないことを再確認する。
executeは同じ読み取り照合を再び行い、その後にだけ更新する。
更新後は新Version、namespace不変、認証、tags、投稿API 404、CPUを確認する。
投稿API有効化やDiscord実投稿へ自動で進まない。

## 8. 試験結果

| 試験 | 結果 |
| --- | --- |
| 新ラッパー | 14/14 PASS |
| 既存検証専用CLI | 12/12 PASS。安全機構も維持 |
| 合計 | 26/26 PASS、失敗0 |
| npm test | パーサーPASS、既存Node 113/113 PASS |
| 新ラッパーdry-run | PASS、85.11 KiB / gzip 21.44 KiB |
| 同じconfigを使った原版dry-run | PASS、同じサイズ |
| node --check | 新CLIと試験の構文PASS |

本番通信はモック。
本番preflightやexecuteを使った試験ではない。
strict拒否試験のAborting表示は期待した拒否結果。
試験作成中に読取パスのassertionがaccount rootとdurable_objectsの名称を誤判定したが、対象endpointの意味に合わせて修正し、最終試験をすべて再実行した。
本番設定を変更して合わせたものではない。

原版と新ラッパーの生成index.jsは完全一致。

```text
SHA256（両方）:
34AC207CD3BDF5683C2993D26864B40EDDA295C40C108047E2C7B9418298D12E
```

以前の値なし専用configはproject rootが異なるため、比較は今回と同じworker/wrangler.jsoncで行った。
Workerコード、package/lock、既存検証CLI、インストール済みWranglerは変更していない。
今回ブラウザ/workerdの全試験を再実行したとは扱わない。

## 9. 停止条件と残存リスク

- 原版Wrangler、既存configのSHA、最新Versionが変わったら停止。
- account/namespace/class/backend/tag不一致、Secret名不足、未知Binding/設定、API取得失敗は停止。
- upload metadata変更、Migration生成、legacy PUT経路、strict警告は停止。
- 実API schemaがモックと異なる場合も停止。実レスポンスでの確認は未実施。
- 複数GETと外部uploadを原子的にできない。二度の照合後に別管理者が変更する競合を完全排除する保証はない。
- 最新Versionとactive Versionが異なる場合は停止し、意図せず未配信versionを採用しない。
- account IDの実値未受領。実行者が承認対象のIDを指定する必要がある。
- Cloudflare Git連携等の別writerは事前に確認し、競合を避ける運用が必要。
- 元WranglerにはAPI失敗時のretryがある。ラッパー自身は自動再実行せず、version POSTの各試行前に再照合するが、外部APIに対するexactly-onceは保証しない。
- upload後の応答消失やdeployment途中失敗では、read-onlyで現行状態を確認し、同じコマンドを無条件に繰り返さない。
- 本番CPU、Secret値の正しさ、Bot実投稿権限は未検証。今回Secret値を取得していない。

今回の完了は実行手段の準備であり、本番移行成功の判定ではない。

## 10. 変更ファイルと保全

追加した追跡候補は次の3件。

- worker/tools/wrangler-stage1-deploy.cjs
- worker/tests/wrangler-stage1-deploy.test.cjs
- worker/docs/phase3/STEP6B-STAGE1-PRODUCTION-CLI-PREP.md

既存worker/wrangler.jsoncの未コミット差分と.bakは変更やGit追加をしていない。
検証専用CLIと原版Wranglerも開始前後のSHAが一致した。
dry-run生成物はignoredのworker/work配下だけ。
本番設定、Secret、DO保存データ、Migration、Discordに変更なし。
今回commit/push指示はないため、成果物はローカル保存のみ。
検証完了時点で停止し、次の明示指示を待つ。

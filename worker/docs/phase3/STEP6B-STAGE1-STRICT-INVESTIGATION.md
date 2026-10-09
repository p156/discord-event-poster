# Stage 1のstrict停止とDurable Object Binding差分の調査

調査日：2026-10-10（日本時間）。
対象：p156/discord-event-poster、Wrangler 4.149.0。
本番デプロイ、strict解除、本番設定変更、Migration、Secret取得や変更、Discord実投稿は行っていない。

## 1. 結論と確認範囲

提示された`durable_objects.bindings: [{}]`を、インストール済みWrangler 4.149.0の比較関数で再現した。
再現した具体的原因は、remote Binding変換で生成される`script_name: undefined`と`environment: undefined`というown propertyを、ローカルで省略した項目の削除と判定すること。
差分表示はundefinedの値を印字しないため、削除の中身が見えず空オブジェクトに見える。
これはBindingを空にする指示でも、namespaceの削除を検知した証拠でもない。

ただし本番管理APIの実Binding JSONは今回取得していない。
提示ログを完全に再現する不具合の存在は確認済みだが、ユーザーPCの実応答でどちらのoptional項目が未設定か、ログ全体に別の差分がないかは最後に確認する必要がある。
「本番Bindingが必ず2項目ともundefinedだった」とは断定しない。
本番再実行は現時点では保留する。

## 2. ユーザー確認済み本番情報

| 項目 | ユーザー確認情報 |
| --- | --- |
| Worker | discord-event-poster-api |
| 最新Version | a9901f55-6b22-4a67-8ce6-4c2dca5e4e3d |
| Binding/Class | AUTH_STATE / AuthState |
| Namespace ID | 5157fbc20842458f8e8269b821e51f47 |
| Migration Tag/Storage | auth-v1 / SQLite |
| Compatibility Date | 2026-04-01 |
| Secret | 5件登録 |
| Observability/Preview URL | Disabled / Disabled |
| Custom Domains/Routes | なし |

これはユーザーからの確認結果であり、この環境から取得した本番metadataとは区別する。
本番Versionが以前のPreflightから変わっているため、再実行前はこの新しいVersionを基準に再確認する。
接続先のidentityをBinding名だけで判断しない。

## 3. 比較の仕組み

インストール済み公式npmパッケージの`node_modules/wrangler/wrangler-dist/cli.js`を確認した。
package版は4.149.0。
調査時bundle SHA256は`31866B9A3686777254819158E60EBE4920D1D91141CDE68846C62B52F75D7A66`。
node_modulesのファイルは変更していない。

処理順序は次のとおり。

1. preUploadApiChecksが本番service情報を読む。
2. dashboard由来の最終deploy等の検査経路で、downloadWorkerConfigがremote設定をWrangler形式へ変換する。
3. mapWorkerMetadataBindingsがDO Bindingをname、class_name、script_name、environmentのオブジェクトへ変換する。
4. getRemoteConfigDiffがローカルとremoteを正規化し、配列順序をそろえてdiffJsonObjectsへ渡す。
5. bundled json-diff 1.0.6が項目の存在を調べ、差分へ__deleted等を付ける。
6. isNonDestructiveは削除や配列要素の変更を破壊的として扱う。
7. CI等の非対話環境でstrictが有効な場合、getDeployConfirmFunctionは継続を拒否する。

strictは「全Bindingの同一性やMigration安全性の証明」ではない。
この調査では、検査対象の差分生成自体にfalse positiveがあることを確認した。
strictを外して回避する方法は採用しない。

## 4. DO Bindingの比較対象フィールド

| フィールド | remoteからの変換 | 意味と扱い |
| --- | --- | --- |
| name | 必ず生成 | Workerから参照するBinding名。AUTH_STATEを維持 |
| class_name | 必ず生成 | 実装class。AuthStateを維持 |
| script_name | 値未設定でもpropertyを生成 | 別Worker等の接続先指定。省略とundefinedを区別する不具合の候補 |
| environment | 値未設定でもpropertyを生成 | 参照環境指定。同じ不具合の候補 |
| namespace_id | このWrangler設定変換に含めない | strictのこの比較ではID一致を確認できない。別途確認が必要 |

現在のローカルBindingはnameとclass_nameだけ。
JSONCで省略したoptional fieldはown propertyがない。
remote変換は値がundefinedでもscript_nameとenvironmentをown propertyとして作る。
reorderBindingsのキー生成はJSON.stringifyを使うためundefinedを落とすが、その後のobject比較は元オブジェクトのown propertyを使う。
したがって並べ替えで同じ要素に見えても、比較で削除差分になり得る。

該当実装の位置（このbundle内の1始まり行番号）：

- mapWorkerMetadataBindingsのDO変換：32528付近。
- json-diffのobjectDiff：179195付近。
- diffJsonObjects/isNonDestructive：179461/179470。
- getRemoteConfigDiff：179520。
- normalizeRemoteConfigAsResolvedLocal/reorderBindings：179711付近以降。
- getDeployConfirmFunction：180007。
- preUploadApiChecks：180400付近以降。

Context7で公式SDK資料を参照したが、この不具合の直接説明は得られなかった。
版を指定したGitHubソースURLの取得も失敗したため、現行mainの挙動を4.149.0の証拠に代用していない。
原因判定の根拠は上記版のローカル公式bundleと、その関数を実行した再現結果。

## 5. 空オブジェクト表示の再現

実際の比較関数とmetadata mapperをメモリー上で呼び出した。
本番APIではなく、ユーザー確認情報を使ったテスト用Bindingを渡した。
Wrangler CLIのmain処理やuploadは呼び出していない。
global fetchを禁止して実行した。

```javascript
// mapperが作るremote比較オブジェクト
{
  name: "AUTH_STATE",
  class_name: "AuthState",
  script_name: undefined,
  environment: undefined
}

// ローカル
{
  name: "AUTH_STATE",
  class_name: "AuthState"
}
```

比較内部では次の変更として残る。

```javascript
{
  durable_objects: {
    bindings: [["~", {
      script_name__deleted: undefined,
      environment__deleted: undefined
    }]]
  }
}
```

json-diffの表示処理はundefinedを印字しない。
括弧だけが残り、提示された空のBindingと同じ形式になる。
strict用判定は表示文字列ではなく内部差分を見ているため、nonDestructive=falseとなって停止する。

## 6. ローカル検証結果

| 試験 | 結果 |
| --- | --- |
| remote optional項目未設定、元のローカルBinding | 空オブジェクト差分を再現。nonDestructive=false |
| 両側にundefinedのown propertyをそろえたメモリー試験 | diff=null |
| remoteに明示的なscript_name、ローカル省略 | script_name削除が表示される。単に空差分とは異なる |
| 同じscript_nameをローカルに追加、environment省略 | environment未設定差分が残り、空オブジェクトになる |
| remoteのundefined項目だけを比較前に除く試験 | 元のローカルBindingでdiff=null |
| 上記正規化後にname/class/script/environmentを実際に変更 | 4ケースともnonDestructive=false。実差分を隠さない |
| 正規化後にenvironment:nullを指定 | nonDestructive=false。undefined以外を除外しない |
| namespace_idだけを別IDに変更 | この比較はdiff=null。IDの独立確認が必須であることを実証 |

診断スクリプトはignoredのwork/strict-binding-audit.cjs。
再現と修正案の正規化試験はローカル限定。
Wranglerや本番設定へ修正を適用したものではない。
node実行はexit 0。
文書内の読み取り用PowerShellは構文解析エラー0。本番取得の実行証拠ではない。
workerの全回帰試験や本番dry-runを今回再実行したという意味ではない。

## 7. 採用しない回避策

- strictを外す、非対話時の自動承諾でuploadする。
- Bindingやmigrationを削除して比較対象から外す。
- namespace IDをWrangler設定へ推測で追記する。
- script_nameを無条件に追加する。environment未設定差分が残ることを再現済み。
- environmentを空文字やproductionへ推測設定する。比較対象や参照先を変えるだけで、未設定との同一性は保証できない。
- JSONCへundefinedを記述する。JSON値ではないため実現しない。
- nullで項目を埋める。メモリー比較では同値にできても、Wrangler validatorはoptional項目にstringを要求する。nullによる設定修正案にはしない。
- ローカル構成を本番から自動patchするpromptを承諾する。未コミット設定を保持できなくなる。

## 8. strictを維持する修正案

推奨は、Wrangler側の比較正規化を修正する方法。
DO比較オブジェクトのscript_nameとenvironmentについて、値がundefinedのown propertyだけを取り除き、省略と同じ表現にそろえる。
name/classや値のあるscript_name/environment、他のBinding、Migration、strict拒否処理は変更しない。

```javascript
// 比較用DO Bindingにだけ適用する修正案。今回適用していない。
const normalized = { ...binding };
for (const field of ["script_name", "environment"]) {
  if (normalized[field] === undefined) delete normalized[field];
}
```

このように限定した公式修正済みWranglerがあれば、その版とテストを確認して利用する方法を優先する。
ただし最新版なら修正済みだとは確認していない。
packageの更新、lock更新、依存互換性検証は次の承認後に実施する。
公式修正版がない場合は、原版とhashを保持した監査可能な局所patch版を別承認で準備する案がある。
元node_modulesや本番構成を黙って編集せず、patch差分と正常/異常系試験をレビューする。
strictの削除、isNonDestructiveを常にtrueにする変更、DO差分の全面無視は認めない。

現時点では修正版の実CLI、upload metadata、live設定比較、dry-runを検証していない。
ローカルの正規化案試験だけで「そのまま本番deploy可能」とは判定しない。

## 9. 安全な次の手順

まず認証済みユーザーPCで、最新VersionとBindingのscript_name/environmentを読み取り確認する。
Secret値やJSON全体を表示せず、項目の有無も含めて取得する。
現在のnamespace IDとauth-v1も再確認し、別の自動更新がなかったことを確認する。
参照用の安全なPowerShell例：

```powershell
$strictAuditRaw = & npx wrangler versions view a9901f55-6b22-4a67-8ce6-4c2dca5e4e3d --config worker/wrangler.jsonc --name discord-event-poster-api --json
if ($LASTEXITCODE -ne 0) { throw 'Metadata取得失敗。再デプロイせず停止してください。' }
$strictAuditVersion = ($strictAuditRaw -join "`n") | ConvertFrom-Json
$strictAuditBinding = @($strictAuditVersion.resources.bindings | Where-Object { $_.type -eq 'durable_object_namespace' -and $_.name -eq 'AUTH_STATE' })
if ($strictAuditBinding.Count -ne 1) { throw '対象Bindingを一意に確認できません。' }
$strictAuditBinding = $strictAuditBinding[0]
[pscustomobject]@{
  versionId = $strictAuditVersion.id
  name = $strictAuditBinding.name
  className = $strictAuditBinding.class_name
  namespaceId = $strictAuditBinding.namespace_id
  hasScriptName = $null -ne $strictAuditBinding.PSObject.Properties['script_name']
  scriptName = $strictAuditBinding.script_name
  hasEnvironment = $null -ne $strictAuditBinding.PSObject.Properties['environment']
  environment = $strictAuditBinding.environment
  migrationTag = $strictAuditVersion.resources.script_runtime.migration_tag
} | ConvertTo-Json
```

これはGET系取得であり、deployではない。
version APIとservice settingsの表現が違う可能性も残るため、version表示だけでstrict経路の実応答を完全に再現したとは扱わない。
取得値が異なる場合は修正案の範囲を広げず、読み取り調査を追加する。

次に正規化修正版の準備を別途承認し、同じBindingでfalse positiveが消え、本当のname/class/script/environment差分ではstrictが停止することを検証する。
upload用BindingとMigration生成処理が未変更であることを確認し、Secretなし設定でdry-runする。
その後に結果を提示してStage 1再実行の承認を得る。
修正と再実行を一括で自動実施しない。

## 10. namespaceとMigrationを保持する条件

再実行前後でnamespace IDは5157fbc20842458f8e8269b821e51f47、classはAuthState、backendはSQLite、live tagはauth-v1であること。
同Worker、同account、同singleton personal-auth-v1を保持する。
WranglerのgetMigrationsToUploadは、live tagがローカル最後のauth-v1と一致する場合に追加Migrationを送らない。
tag取得不可、未設定、不一致、rename/transfer/delete要求があれば中止する。
正規化修正をMigration処理に広げない。

keep-vars、FORUM_POSTS_ENABLED:false、CI＋strictを維持する。
Secret添付、鍵の再生成、Binding再作成、認証/履歴の初期化を行わない。
更新後は投稿API 404、認証とtags、namespace ID、保存履歴、CPUを確認する。
strictが通ることは必要条件の一つであり、namespace IDの保証そのものではない。

## 11. 残存リスクと再実行判定

本番API optional項目の表現、修正版Wranglerの実CLI、その他remote差分、最新deployの競合は未検証。
本番CPUとDiscord実投稿の確認も次のStageの承認範囲へ残る。
この調査では「再実行保留」とする。
strictを維持した比較正規化修正の検証と、実設定照合が完了するまで同じdeployを繰り返さない。

## 12. ファイル保全

既存Wrangler差分と.bakを変更していない。
productionコード、package/lock、node_modules、本番設定に変更なし。
追加した文書は本書だけ。診断用scriptはignoredのwork配下で、production経路には接続していない。
設定とWrangler bundleのSHA256は調査前後で一致した。

```text
worker/wrangler.jsonc: D4D5326B330B36950FD47320E246E46C9A9A27626055614053A77445B620505F
worker/wrangler.jsonc.bak: 7F28CAB37EACF66ED31162FF08640D74B18878B9B3CFF75EBB278286F925723F
```

本書はローカル保存。今回の調査依頼には新たなcommit/pushの明示指示がないため実施していない。

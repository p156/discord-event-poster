# Phase 2 本番PBKDF2上限修正

## 原因と調査

本番ログの `NotSupportedError: iteration counts above 100000 are not supported (requested 600000)` は、WorkerのWeb Crypto PBKDF2実装の制約。反復数はSecretに格納された値から600,000回として渡されていた。Cloudflareの[workerd issue #1346](https://github.com/cloudflare/workerd/issues/1346)に上限と実装への参照がある。[上限引上げPR #7550](https://github.com/cloudflare/workerd/pull/7550)も調査時点ではOpenだった。本番の解除を前提にしない。公式Web CryptoページにPBKDF2対応の記載はあるが、今回確認した本文では10万回上限の記載は見つからなかった。Nodeやローカルworkerdの成功を本番互換の証拠にしたことが前回検証の不足。

## 方式比較と採用

|方式|既存Secret|安全性・運用上の評価|
|---|---|---|
|Web CryptoのPBKDF2を100,000回へ下げる|元のパスワードから再生成が必要|60万回に比べ推測1回の計算量は約1/6。試行制限は漏洩ハッシュへのオフライン攻撃を防がないため不採用|
|Argon2idへ移行|新形式のハッシュ生成と移行が必要|メモリーハードな有力方式。OWASP最低例は19 MiB・2回・並列度1。WASM/JS依存とメモリー・CPU検証、Secret移行が増えるため今回の互換修正には採用しない|
|外部IdP/Cloudflare Access|認証設計と画面の移行|パスワード検証の運用を委譲できるが、今回の修正より範囲が大きい|
|標準PBKDF2-SHA256 600,000回をJSで計算（採用）|**そのまま互換、再生成不要**|RFC 8018の同じ計算をWeb Crypto外で行い、推測コストとソルトを維持。JS CPU負荷と追加依存の管理が必要|

[OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)のPBKDF2-HMAC-SHA256の60万回という目安を維持する（FIPS認証済み実装であるという主張ではない）。[noble-hashes](https://github.com/paulmillr/noble-hashes)のPBKDF2とSHA256のサブモジュールを利用し、`@noble/hashes` **2.4.0**をlockfileで固定。ライブラリには過去の監査があるが、監査対象バージョンは1.0.0であり、2.4.0全体の独立監査を保証するものではない。自作暗号・独自の分割/連鎖PBKDF2形式を導入しない。クライアントに計算を移さない。

## 互換性と保持対象

`APP_PASSWORD_HASH` は `pbkdf2-sha256$600000$<salt hex>$<digest hex>` のまま。UTF-8パスワード、同じ16バイトソルト、32バイト出力、600,000回を保持する。PowerShell生成済みのハッシュも同じ標準PBKDF2。Nodeネイティブ実装が生成した独立のハッシュとの一致（日本語・絵文字を含む）と、その既存形式でのログインを検証した。

**既存APP_PASSWORD_HASHとSESSION_SIGNING_KEYはどちらも再生成・更新しない。** Bot Token・フォーラムID・Originも変更しない。Secret値を取得・表示する必要はない。既存準備スクリプトを修正用に再実行しない（新しい署名鍵を生成してしまう）。

Durable Objectのクラス・固定オブジェクト名・保存キー・migration・署名フォーマット・期限・20セッション上限・15分に5回の制限・ログアウト失効を維持。デプロイ時にisolateが再起動しても、保存済みセッション/試行回数を同じDOから読み出す設計。検証失敗時の認証迂回はない。弱い100,000回の保存形式は受け付けない。計算で使った一時バイト配列は消去する（JS文字列やGCコピーの完全消去を保証するものではない）。

## テストと制約

`npm test`: 既存29件＋追加4件＝33件PASS、parserのassertionsもPASS。

追加試験はWeb CryptoのderiveBits/deriveKeyへ明示的な上限制約を入れる。100,000回は許可、100,001/600,000回は報告と同種のNotSupportedError。旧計算の失敗を再現し、新計算がそのAPIを呼ばず既存Secretで成功すること、誤パスワード401、旧session再利用401、上限429、弱い/不正な保存形式503を確認する。これによりローカルランタイムが制約を解除していても回帰を検出できる。

`npm run test:worker-runtime`: 本番と同じ依存をesbuildでバンドル、workerd＋SQLite DO＋明示的上限を組み合わせてログイン/誤パスワード/署名session/ログアウト再利用を検証しPASS。初回起動込みローカル経過時間は約1,579 ms。本番CPUの値ではない。

`npm run test:browser`: 既存受入14項目PASS（1280/390/320px含む）。`npm run test:phase2-browser`: PASS。ブラウザ試験のAPIはモックであり、実Discordや本番認証へ接続していない。`wrangler deploy --dry-run`: バンドルPASS。

再現対象は報告されたPBKDF2上限であり、本番の全制約を再現しているわけではない。JS実装はnativeよりCPU/経過時間が増える。重い計算は既存DO内でのみ行い、試行制限を先に共有ストレージに記録する。外側Workerでは実行しない。[DOの公式CPU上限](https://developers.cloudflare.com/durable-objects/platform/limits/)は既定30秒。DOのCPU時間と課金、本番Pagesの15秒待ち制限内での応答は再デプロイ後に計測する。無料Workerの小さいCPU枠をDOへそのまま適用して説明しない。非同期版のyieldがCPU上限を解除するわけではない。必要ならプラン/方式を再評価し、反復回数を自動で下げない。

## 確認後の再デプロイ手順

**本番デプロイはユーザー確認後だけ実行する。今回実行したのはdry-runまで。**

1. 修正commitを取得し `npm ci`。5Secretが登録されていることは名前だけで確認する。値の読出し・表示・再登録は不要。
2. 既存Worker名 `discord-event-poster-api`、`AUTH_STATE` binding、既存 `auth-v1` migration、現在のroute/設定を維持する。新しいDOクラスやmigrationを追加しない。ローカルの `preview_urls: false` と設定バックアップはユーザー変更として保持し、修正commitには含めない。
3. `npm test`、`npm run test:worker-runtime`、`npm run test:browser`、`npm run test:phase2-browser` を実行する。
4. `npx wrangler deploy --config worker/wrangler.jsonc --dry-run`。確認後、同じコマンドから `--dry-run` だけ外して既存Workerを更新する。Secret put/delete/bulk、DO削除、migrationリセットは行わない。
5. Pagesから既存パスワードで1回ログインしてタグ取得、ログアウト後の401を確認する。誤パスワード401と6回目429を確認する際は通常ログインも試行回数に含まれる点に注意。今回までの失敗で制限中なら最後の試行から15分待つ。CPU計測はCloudflare側Metrics/プロファイラーを使い、パスワード・token・Webhookをログへ出さない。
6. 問題があれば旧commitへの単純ロールバックでは元の本番エラーが戻るため、認証を閉じた状態で原因確認する。署名鍵交換や認証無効化で回避しない。

今回の修正完了判定は「実装・上限再現付き検証・GitHub反映済み、本番再デプロイと実ログイン受入は確認待ち」。

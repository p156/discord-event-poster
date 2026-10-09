# Phase 3 実装計画 — Step 1確定、Bot API方式

Step 4 status: [STEP4-RESULTS.md](STEP4-RESULTS.md). Local frontend/formal-router
integration is complete behind a default-off server gate. Step 5 and production
activation remain pending a subsequent user instruction.

Step 3 scope update: [STEP3-RESULTS.md](STEP3-RESULTS.md). Contrary to the original
future-publication plan below, the current Step 3 instruction requires internal
integration only. Public activation/capabilities and frontend work remain deferred.

基準main: ff63a4a。ユーザー確定仕様/API契約は [DESIGN.md](DESIGN.md) / [API-CONTRACT.md](API-CONTRACT.md)。
下記のProductionファイルは将来の変更予定。今回は設計3文書/READMEだけ変更する。
全Step共通: 既存Worker discord-event-poster-api、AUTH_STATE/AuthState/personal-auth-v1/auth-v1、
PBKDF2-SHA256 600k、既存Secret、Bearer失効/ログイン制限、固定forum、manual＋3xx拒否を維持。
新Webhook Secret、DO migration/new binding/new Workerは不要。

## Step 1: 設計・API契約確定（今回完了）

- 対象: DESIGN.md、API-CONTRACT.md、IMPLEMENTATION-PLAN.md、README.md。
- 内容: Bot方式/表示、解析preview非認証、投稿auth、全利用者10attempt/連続60秒、履歴30日、
  永続化前送信禁止、確認＋新IDでの再投稿、不明自動retry禁止、fallback禁止、Bot受入後の旧Webhook削除を確定要件へ変更。
- 技術契約: サーバーUUID＋30日期限署名ticket、発行API、POST、同ID GET、state/error/Unicode/16KiB、
  atomic beginSend＋shared sliding window、expiry後410/record消失503に確定。
- 調査: Forum createのpayload/receipt/権限、400系/429/5xx、mentions、thread/message編集削除、Workers redirectを公式優先で確認。
- レビュー: 旧Webhook推奨/追加Secret/10回10分/2秒間隔/無期限tombstone/未決Owner Gateを後続契約から撤去。
- 完了条件: Bot方式で3文書が一致、Step 2/3を分離しpublic writeを先に開かない、保存/expiry/rate障害の扱いが明確。
- リスク/限界: タグ取得成功をSEND_MESSAGES確認と誤る、Host検証を既存実装ありと誤認、公式characters単位を推測する。いずれも設計へ明記。
- 実装開始: 次のユーザー指示までStep 2へ進まない。

## Step 2: Worker側Bot投稿処理・入力検証（非公開adaptor）

- 目的: 固定forumへの正しいBot requestとreceipt/error変換を作り、入力/宛先/秘密を検証する。
- 予定ファイル: worker/src/index.mjs、提案新規worker/src/forum-posts.mjs、worker/src/discord-client.mjs、
  worker/tests/forum-posts.test.mjs、worker/tests/security.test.mjs。parser選択で必要な場合だけpackage/lock。
- 内容: strict JSON/16KiB/read5秒/UTF-16/normalization、固定host/Origin/Bearer、タグ/親forum再取得、
  Bot Authorization、name/message/applied_tags、parse=[]/replied_user=false、manual/3xx拒否、
  fetch＋body全体10秒/response64KiB、type11/parent/guild/message receipt検証、安全なcode/ログ。
- 権限: VIEW_CHANNEL/SEND_MESSAGES、必要時MANAGE_THREADS。moderated未確認は停止、GET tagsだけで許可しない。
- 非公開Gate: transport adaptorをmock試験からだけ呼ぶ。public POSTから送信可能にしない。
  Step 3のticket/永続state/rate統合前はproduction write経路なし。Bot APIへの実通信はしない。
- テスト: 100/101・2000/2001 UTF-16、emoji/結合/ZWJ/CRLF/surrogate、16KiB境界/虚偽length/read timeout、
  0/5/6タグ/重複/別forum/消滅/required/moderated、Host/Origin偽装、任意URL/Token/member拒否、
  正常Bot request、400/401/403/404/429/5xx/3xx、不正receipt/body timeout、秘密を含む例外の非露出。
- 完了: adaptor/全回帰PASS、invalid/preflight失敗でmock POSTゼロ、public writeは無効。現在のtag/auth GETに回帰なし。
- リスク: POSTを先行公開、Bot adminを万能proxyの根拠にする、message.id欠落を推測補完、upstream401をuser session401へ混同。

## Step 3: DO永続状態・頻度制限（public write統合Gate）

- 目的: Step 2のadaptorを、永続化/競合防止/expiry/rateが通った後だけ公開APIへ接続する。
- 予定ファイル: worker/src/index.mjsのAuthState/ルーター、提案worker/src/post-state.mjs、
  forum-posts.mjs、worker/tests/post-state.test.mjs、forum-posts.test.mjs、worker/tests/runtime.mjs、必要時package scripts。
- 内容: post-intents、not_started保存、UUID/ticket発行、HMAC domain分離、payload/target hash、
  preparing lease/CAS、sending commit、receipt保存、GET、30日expiry/清掃、全利用者10件sliding window、
  Discord bucket/global cooldown、明確な429のみsafe retry、過去key/missing record拒否。
- 構成: 既存DO/key scope/migration維持。新posts/rate/cooldown namespace追加だけ。
  外部networkをDO queue/transactionから外し、authを待たせない。alarmはauth清掃とpost期限を協調。
- 公開: Step 2＋3の事故試験PASS後のみroutesを有効化。未統合はdisabled/fail closed。
  GET /api/sessionに後方互換capabilities（forumPosts/version/ticket）を追加する。
  tagsへconstraints/requireTag/moderated/selectableを追加、既存mapping保持。
- テスト: 発行時保存失敗でticket/POSTなし、signature改変/期限/UUID・principal・hash不一致、
  同key並行1write、global11並行10以下、session跨ぎ同record、旧attemptCAS拒否、
  sending commit失敗でwriteゼロ、sending commit後crash→unknown、success後記録不能→unknown、
  receipt commit後lost reply→replay成功、late同attemptreceipt、DO再作成、quota永続化失敗→write0、
  60秒ちょうど境界、拒否/429/unknownの算入、replay/GET非算入、29日/30日境界、
  record削除後ticket410、日時改変署名拒否、valid ticket記録消失503、expire120秒前dispatch停止、
  清掃遅延時の失効、expired recordの再保存禁止、旧sessions/attempts復元。
- 完了: mock failure-injection＋SQLite workerdでPASS。10件制限がsessionやエッジ分割で抜けない。
- リスク: 30日後keyだけ受付し直す、session IDでscopeを分ける、ticketをBearer代用にする、
  期限をpost retryで延長、保存未完了でfetch、counterをメモリーへfallback、auth alarmを上書き。

## Step 4: フロントエンド統合・Webhook直送撤去

- 目的: 解析/previewを非認証で維持し、投稿だけBot対応Workerへ移す。
- 予定ファイル: app.js/index.html、必要範囲styles.css、tests-v010.js/tests-acceptance.cjs、
  tests/phase2-browser.cjs、提案tests/phase3-browser.cjs、README.md。
- 内容: 正規化snapshotのpreview、投稿確認/login、ID変換、intent発行、UUID/ticket/期限のsessionStorage保存、
  同payload POST、state adaptor、同ID GET/poll、reload/relogin、pending lock、expired/unknown/known failure表示、
  guild/thread/messageリンク、意図的再投稿専用確認→新発行。
- 撤去: Webhook URL入力/表示/remember/forget、localStorage保存/復元/参照、ブラウザDiscord POST、
  webhook-check依存、旧failure-only直送retry。対象の旧保存キーだけ削除/案内し他データ不変更。
- 互換: 入力/解析/手動タグ/根拠表示/プレビュー/順次queue/部分結果を維持。旧transport固有試験は
  同等のWorker契約試験へ置換するが、安全性期待を消さない。Bot名義変更は合意済み。
- テスト: 非認証解析/preview、投稿時login、入力→preview→POST一致、二重click/disabled再描画、
  部分結果、401再login同ticket、429wait、lost reply→GET、reload sameID、
  storage失敗でPOSTなし、unknown自動新keyなし、意図的確認新ID、expires410、
  missing能力旧Workerにwriteなし、Token非露出、ブラウザDiscord POSTゼロ、PC/390/320px。
- 完了: mock画面PASS、旧直送コードなし。Worker不通で編集/preview可、投稿停止。
- リスク: API非2xx一律throw、login後タグ脱落を黙認、reload後UUID再発行、直送fallback。
- 旧Webhook実体: このStepで削除しない。旧Pagesキャッシュの切替期間リスクを記録。

## Step 5: セキュリティ・ブラウザ・Worker E2E

- 目的: 本番前にBot payload/認証/署名ticket/共有state/事故境界をまとめて検証。
- 予定ファイル: worker/tests/*.mjs、tests/phase3-browser.cjs、browser-acceptance.cjs、pages-verify.cjs、
  package scripts、提案worker/PHASE3-ACCEPTANCE.md。
- 内容: workerd＋SQLite＋PBKDF2本番上限fixture、既存DO状態fixture、mock Discord、Clock/expiry/並行、
  UI→intent→POST→status全経路。必要なbundle/dry-runを将来実施し、本番Secretを読まない。
- テスト: 現36件/解析の安全性期待、Phase 2/新Bot UI、ticket30日signature、rate/sliding/全session共有、
  redirects/mentions/型/上限/任意先拒否、Host/Origin/Bearer/失効/login上限、
  result commit失敗/Worker再起動/timeout/parse、secret/body/hash/ticket/log非露出、post後deleteなし。
- 完了: 全FAIL解消、API/error/stateと文書一致、mock/runtime/browserの証拠を区別。実Discord送信0。
- リスク: ローカルテストだけで本番権限/CPUも証明したと誤る、unknownを成功mockだけで検証、
  古いWebhook試験を削除してcoverageが落ちる、テストがPagesに公開される。

## Step 6: 承認後の本番デプロイ・Bot受入・旧Webhook削除

- 目的: 固定forumとBot実権限/表示/receipt/CPUを確認してから旧Webhookを削除する。
- 予定ファイル: worker/DEPLOYMENT.md、worker/PHASE3-ACCEPTANCE.md、app/index asset version、
  README/契約撤去記録。必要な将来feature gateのみworker設定へ承認後反映、ローカルdiff/backup保持。
- 前提: 既存5Secret/Worker/AUTH_STATE/auth-v1保全。追加Webhook Secretなし、署名鍵再生成なし、migrationなし。
- 承認: 本番deploy、許可された1イベントの実投稿、旧Webhook削除の実行は別途ユーザー確認後。今回はどれも実行しない。
- 手順: dry-run→ユーザー承認→既存Worker deploy→readonly/auth/capability確認→固定forumのBot有効権限確認→
  承認済み1件をBot投稿→親/タグ/表示/receipt/link/同keyreplayとCPU確認→Pages配信/旧直送撤去確認→
  ユーザー確認済み対象の旧Webhook削除→旧キー/古cacheの移行完了確認。
- Webhook削除はBot API本番成功の後に行う。失敗なら削除せずBot経路を停止して原因調査。旧直送へfallbackしない。
- テスト: 実1件とsame-keyreplayで新スレッドなし、Bot Token不露出、GET履歴、guild/forumタグ、リンク、
  Phase 2継続。大量429/障害注入は本番ではなくmockの証拠を使う。
- 完了: 本番Bot受入/Pages一致/旧Webhook削除が確認・記録済み。運用仕様が実装・UIに一致。
- リスク: タグ読取だけで投稿権限を推定、削除対象取り違え、古いPages、実投稿後receipt欠落、CPU上限。
- rollback: 新投稿受付を停止し状態照会/authを維持。unknown/rate/履歴を削除しない。30日期限は維持。
  Discord投稿がなかったことにしない。旧Webhookの自動再作成/ブラウザ直送復活は禁止。
- 非対象: Phase 4の内容/過去投稿重複検出、URL本文取得、AI、公開編集/削除API。

## 依存・事故防止Gate

~~~text
Step 1 契約確定
  → Step 2 adaptor＋validation（public writeなし）
  → Step 3 ticket＋state＋global rate（Step 2と統合して初めてpublic write）
  → Step 4 UI＋旧直送撤去
  → Step 5 統合受入
  → Step 6 承認後deploy＋Bot実確認 → 旧Webhook削除
~~~

|事故/境界|期待|追加Discord write|
|---|---|---|
|intent保存失敗/ブラウザstorage失敗|停止、未開始|0|
|auth/Host/Origin/schema/タグ検証拒否|固定code、非作成|0|
|preparing競合/古attempt|CAS拒否、pending表示|古attempt0|
|sending/slot commit失敗|STATE_UNAVAILABLE|0|
|commit後fetch前crash|unknownになり得る、再送禁止|retry0|
|POST timeout/5xx/解析失敗|unknown、sameID照会|retry0|
|Discord成功→receipt保存失敗|unknown/sending→照会|retry0|
|receipt保存→返信消失|同ticket回収成功|新規0|
|samekey並行|唯一のattempt、他replay/pending|1|
|11異key並行/global複数session|10送信以下、1以上APP_RATE_LIMITED|最大10|
|60秒/30日ちょうど|slot解放/410失効|期限外0|
|30日削除後oldticket/日時改変|410/署名拒否、再作成なし|0|
|valid ticketのrecord欠落|503、安全側停止|0|
|意図的再投稿|確認→新UUID/ticket、quota遵守|明示操作1|

## 今回の完了判定

Step 1はBot方式・ユーザー確定仕様・API/期限/rateが一致し、Step 2を開始できる設計として完了。
未実装/未実測事項は本番権限、CPU、実通信・公開配信であり、次Stepのテスト/承認Gateに残す。
commitは設計3文書/READMEのみ。実装は次のユーザー指示まで開始しない。

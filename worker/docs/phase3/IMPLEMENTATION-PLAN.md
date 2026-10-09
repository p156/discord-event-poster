# Phase 3 Step別実装計画（未承認・今回は実装しない）

基準main: 1359bb4。各Stepは将来の変更対象を示す。今回変更したファイルを示すものではない。
全Step共通: 既存Worker名、PBKDF2 600k、既存ハッシュ/署名鍵、AUTH_STATE、sessions/attempts、auth-v1、manual＋3xx拒否を維持する。
実装案は [DESIGN.md](DESIGN.md)、入出力は [API-CONTRACT.md](API-CONTRACT.md)。

## Step 1: 投稿方式・契約の確定（Owner Gate）

- 目的: 実装前に互換性、権限、曖昧な結果の扱いを確定する。
- 変更対象: 本ディレクトリの3文書、README.md。Production code/Secret/設定はまだ変更しない。
- 内容: Webhook/Bot採否、固定投稿先、全投稿auth必須、投稿頻度、tombstone/容量、storage不可の扱い、intentional repost、切替/旧Webhook失効をOwner判断として記録。UI previewの正規化、重複JSON member検出parserなどの技術詳細は実装担当が契約に沿って確定する。
- テスト/レビュー: 代表payloadの本文が既存contentFor/threadNameと一致するか、100/2000 UTF-16境界、5タグ、未登録/重複/required/moderated、状態/HTTP表に矛盾がないかをレビューする。Bot案でもAPI/状態契約が保てるか確認する。
- 完了条件: 判断欄に確定値と根拠が入り、pending/unknownと非作成の再試行条件が合意される。
- リスク: Webhook表示維持と新Webhook入替の希望の競合。情報が足りない権限・Secret運用を勝手に確定しない。

## Step 2: Workerのvalidation・transport adaptor（外部書込を公開しない）

- 目的: 1イベントの入力を安全な固定Discord requestへ変換する。
- 将来変更対象: worker/src/index.mjs、提案新規worker/src/forum-posts.mjs、worker/src/discord-client.mjs、worker/tests/forum-posts.test.mjs、worker/tests/security.test.mjs、必要時package.json/package-lock.json。
- 内容: 16KiB/読取期限/strict schema/正規化、固定forum/tag/Secret照合、Webhook wait=trueとallowed_mentions強制、receipt/error正規化。既存GET helperを必要な範囲だけGET/POST policy共通化。現在のmanual/3xx拒否と安全log分類を回帰維持。
- 公開制御: adaptorはテストから呼ぶだけ。public POST経路は無効。将来POSTING_ENABLEDのdefault falseを使う案で、Secretなし/flag offは送信前停止。新Secretの値はmockだけで試験し本番登録しない。
- テスト: body16KiB直前/直後・multi-byte・false Content-Length・read timeout・unknown/nested/duplicate field・Unicode/control、0/5/6タグ、別forum/ID、Secret URL偽装/query/userinfo/port、Webhook/parent mismatch、required/moderated、GETとPOSTの3xx、upstream400/401/403/404/429/5xx、receipt read timeout、秘密を含む例外/生bodyがlog/responseへ出ないこと。
- 完了条件: adaptor単体/全既存試験がPASS。invalid requestと配置不一致で外部POSTゼロ。public routeから実書込を開始できない。
- リスク: 既存GETの診断を壊す、Bot AuthorizationをWebhookへ誤添付、tokenを含むURLをlogへ記録。汎用任意URL clientにしない。

## Step 3: 永続二重防止・共有制限・状態API（公開統合Gate）

- 目的: 操作の重複配信と不明時の無条件再送を防止してから投稿APIを接続する。
- 将来変更対象: worker/src/index.mjsのAuthState/ルーター、提案新規worker/src/post-state.mjs、worker/src/forum-posts.mjs、worker/tests/post-state.test.mjs、worker/tests/forum-posts.test.mjs、worker/tests/runtime.mjs、package.json。
- 内容: 同じ既存DOへposts record/quota/cooldownを追加。stable Owner＋UUID、canonical hash、target snapshot、reserved lease、beginSend CAS、sending/receipt commit、tombstone保管、GET status、retry eligibility、読取/投稿quota。外部fetchはDO queue/transaction外。既存alarmに安全なpost清掃を追加。
- API: Origin＋Bearerを全新経路へ、Idempotency-Key preflight追加。GET /api/sessionへ後方互換capabilitiesを追加し、新UIが旧WorkerへPOSTしないようにする案。tagsのconstraints/moderated/selectable追加。未有効時capabilities.forumPosts=false。
- 保存互換: binding/class/object name/migrationを変えず、既存sessions/attemptsをそのまま利用。新しいnamespaceのkeysのみ。DO Migrationなしで進める案をruntimeで確認する。
- テスト: 同キー同payload並行POSTが1write、異payload409、別session/再ログイン/別stubでも同record、reserved lease失効後の古いattempt拒否、sending永続化失敗でwriteゼロ、sending直後crashはunknown、Discord成功後receipt保存失敗はunknown、receipt commit後応答消失はreplay成功、5xx/timeout後同キー再POSTゼロ、遅い同attempt receipt回収、retired旧キー410、容量上限、quota/global/bucket/cooldownのエッジ共有、旧AuthState保存復元。
- 完了条件: failure-injectionとSQLite workerdで保証境界がPASS。Step 2＋3が揃って初めてpublic POSTとstatusをfeature gate内で統合。flag off/Secretなしはfail closed。
- リスク: 外部I/Oをtransactionに入れる、全authを10秒以上塞ぐ、期限切れsendingを未送信と誤分類、cleanupによるキー再受付、旧auth alarmの破壊。削除・無条件retryは禁止。

## Step 4: フロントエンド統合（確認・見た目を維持）

- 目的: 既存操作感を維持して宛先/秘密をブラウザから外す。
- 将来変更対象: app.js、index.html、必要な範囲のstyles.css、tests-v010.js、tests-acceptance.cjs、tests/phase2-browser.cjs、提案新規tests/phase3-browser.cjs、README.md。
- 内容: immutable snapshotを共通の正規化でpreview/POSTに利用。UUIDのfetch前保存、auth/capabilityチェック、1イベント1POSTの順次queue、dedicated Worker response adaptor、pending polling、401後のsame-key再照会、known retryable/failed/unknownのUI区別、成功guild/thread/messageリンク。
- 移行制御: Worker経路の明示flag。旧Webhook直送へ自動fallbackしない。旧localStorage URLを読取/送信/自動移管しない。切替までの旧画面は手動選択の別版として扱い、1操作の両経路送信をしない。
- テスト: preview＝POST文字列、UI二重click、複数event部分失敗、429wait、401再認証、新規キー自動発行なし、lost reply→GET成功、reload→同ID照会、storage unavailable停止、unknownからretry禁止、retired表示、API capabilityなしでwriteゼロ、XSS/mentions/log/URL非露出、PC/390/320px。
- 完了条件: Worker対応UIがmock E2EでPASS。解析/タグ/手動根拠は回帰維持。ネットワークにブラウザ→Discord POSTなし。
- リスク: 現workerApiの一律throwで状態を失う、preview後に入力を変え送る、disabled再描画でlockが外れる、Worker失敗時の旧直送が重複を生む。
- 扱い: 古いtransport固有テストは無意味に全削除しない。移行中はlegacy回帰を残し、切替後は同じ安全性期待をWorker契約試験へ置換する。

## Step 5: セキュリティ・E2E受入（ローカルのみ）

- 目的: 本番前に認証/共有状態/外部副作用境界を実ランタイムとブラウザで確認する。
- 将来変更対象: worker/tests/*.mjs、tests/phase3-browser.cjs、tests/browser-acceptance.cjs、tests/pages-verify.cjs、package.json、受入文書（提案worker/PHASE3-ACCEPTANCE.md）。
- 内容: workerd＋SQLite＋PBKDF2本番上限fixture、旧DO状態fixture、mock Discord/timeout/redirect/429/crash、ブラウザUIの全経路。request解析・quota・deadline・write countを観測する。
- テスト: 現36件を含む全回帰、runtime、Phase 2/3 browser、負荷・同時request、Authorization/Secret/例外文/本文/hash非露出、固定target拒否、Origin偽装＋Bearerなし、logout/replay/期限、admin Botでも任意route拒否。テストは架空token。実Discord zero。
- dry-run: 将来の検証用設定でbundled source/required namesを確認。本番Secretを読み込まず、deployはしない。
- 完了条件: 全FAIL解消、実装API/error/stateと文書一致、未知障害は安全側。テストの対象がmock/runtime/実ブラウザのどれかを受入記録に明示。
- リスク: Node/ローカルだけで本番制約も証明したと誤る、成功モックだけでunknownを証明する、テストdataがPagesに公開される。_config.ymlの公開除外を保全する。

## Step 6: 承認後の本番切替・旧経路撤去（別途外部操作の許可）

- 目的: 実際の固定forum/権限/投稿表示/CPUを確認し、旧ブラウザWebhookの認証迂回を閉じる。
- 将来変更対象: worker/DEPLOYMENT.md、worker/PHASE3-ACCEPTANCE.md、承認後だけworker/wrangler.jsoncのrequired Secret名/feature var、app.js/index.html/README.md、tests、asset version。既存ローカル設定/backupはmergeで保持。
- 承認事項: 追加Secret登録、既存Webhook採用/新規固定Webhook準備・旧Webhook失効、既存Workerデプロイ、指定イベント1件の実投稿。本番異常系の大量POSTは禁止。これらは今回未許可。
- 手順: 既存Worker/5Secret/auth-v1/AUTH_STATE保全→管理者による固定投稿Secretの準備→flag offでdry-run/デプロイ→auth/readonly/capability確認→承認済み1件をflag onで投稿→タグ/表示/link/receipt回収/ログ非露出/CPU確認→Pages切替・cache更新→旧URL失効/保管キー削除案内→旧UIコードとwebhook-checkを撤去。
- テスト: 許可した1件のguild/forum/thread/tag/Message receipt一致、same-key replayで新規スレッドなし、ブラウザにBot/Webhook秘密なし、成功リンク有効、auth/GET status継続。network crashは本番ではなくmock済みの証拠に依拠する。
- 完了条件: Worker経由の本番受入、Pages配信一致、旧直接送信なし、旧URL失効/移行完了または残存例外をOwnerが記録、失敗時運用を確認。
- リスク: 古いPagesが既存URLへ送る、old/new webhook混在、設定/権限不足、Secretローテーションで中途operationのtargetが変わる。旧UUIDでtarget変更後に再送しない。
- rollback: 投稿受付flagをoff、status/read-onlyは維持。in-flight/unknown記録とAUTH_STATEは削除しない。外部送信済みを取り消せるとは言わない。旧直送へ自動rollbackしない。既存authは維持する。
- 非対象: Phase 4重複探索、URL本文取得、AI判定、任意Discord proxy、Bot経由投稿の同時実装。

## 事故注入の必須マトリクス（Step 3/5）

|注入場所|期待記録/応答|追加write数|
|---|---|---|
|auth/validation/GET preflight失敗|not_accepted、safeToRetry適切|0|
|reserved保存失敗|503 not_accepted|0|
|reserved期限切れ/古いattempt|CAS拒否、再予約は新attemptのみ|古いattempt 0|
|sending commit直前障害|送信権限なし|0|
|sending commit直後fetch前中断|復旧時unknown（未投稿でも安全側）|再送0|
|POST後timeout/5xx/不正receipt|unknown|再送0|
|Discord success→receipt保存失敗|sending→unknown|再送0|
|receipt保存→browser応答消失|same-key GET/POST succeeded|新規0|
|明確な429→cooldown中再要求|retryable/429|cooldown中0|
|同キー同時要求|1attempt、他は202/replay|1|
|同キー異payload|409|0|
|session再発行/DO再作成|同記録回収|新規0|
|詳細期限切れ/容量上限|410 / 503、旧キー新規化なし|0|
|遅い正当receipt vs unknown|同attemptだけsucceededへ|新規0|

## 今回の設計作業の完了条件

- [x] 1359bb4と最新origin/main一致を確認、tracked実装/設定/テスト/文書を調査
- [x] 確認済み現行仕様と提案を分け、API/状態/Step Gateを作成
- [x] Owner判断が必要な項目を明示
- [x] Phase 4の内容重複探索と配信事故防止を分離
- [x] Production code/設定/依存/テスト変更なし、ローカル設定/backup保持
- [x] 文書のみcommit/push（SHAと結果は完了チャット）
- [ ] Step 1の採用判断（Owner）
- [ ] Phase 3実装・本番受入（将来、今回開始しない）

完了チェックのうち非変更・pushは実際の差分/ハッシュ/remote確認後に確定する。

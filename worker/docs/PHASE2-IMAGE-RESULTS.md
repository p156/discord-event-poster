# Phase 2: 公式画像プレビュー・Discord Embed

2026-10-13 JST。基準 `553724417c91c005104d169598a20c027ca08bc2`、開発ブランチ `event-poster-v2`。
既存計画 `phase2-image-investigation-plan-20261013.md` に基づく実装。

## 現在の契約

`FORUM_POSTS_ENABLED === 'true'` の場合のみ公開する。OAuth2の現在有効な本人セッション、固定Worker Host、完全一致Originを全ルートで要求する。
画像確認票だけでは認証できない。旧Bearer、query、未知項目、重複JSONキー、16KiB超、圧縮入力を拒否する。

- `POST /api/forum/image-preview`: `{apiVersion:2,threadName,content,tagIds,officialUrl}`。
- 成功は200、`{apiVersion:2,status:'image'|'no_image',officialUrl,imageUrl,source,reasonCode,previewTicket,expiresAt}`。`expiresAt`はミリ秒。
- 画像取得失敗だけは200/no_image。認証・入力・DO保存・制限エラーは401/403/400/413/422/429/503を分離する。
- `POST /api/forum/image-thumbnail`: `{previewTicket}`のみ。検証したJPEG/PNG/GIF/WebPバイトを返す。no-store/nosniff、上流ヘッダー・Cookieを返さない。
- サムネイル取得・表示失敗時はimage-previewへ元の投稿内容と`previewTicket,withoutImage:true`を送る。旧確認票を廃棄し、null画像の確認票を発行する。任意画像指定は不可。
- intent: `{apiVersion:2,threadName,content,tagIds,officialUrl,imageUrl,previewTicket}`。
- 実投稿: 同じ入力から`previewTicket`を除く。既存のIdempotency-Keyを用いる。保存したスナップショットと照合し、HTMLも画像も再取得しない。
- v1の入力、SHA-256配列、操作票署名形式、30日、status応答apiVersion:1は維持する。
- v2ハッシュは`[2,threadName,content,sortedTagIds,officialUrl,imageUrl]`。確認票の時刻・IDは含めない。
- session capabilitiesへ`postPayloadVersions:[1,2]`と`officialImagePreview`を追加。旧Workerへの画像付き確認の暗黙降格はしない。

確認票はSESSION_SIGNING_KEYの別ドメイン`forum-image-preview:v1`、10分。
本人principal、forumId、基本本文ハッシュ、公式URL、画像結果を結ぶ。
DO内の署名内部通信で確認票を登録し、intent発行と同一transactionで一度だけ消費する。
再利用・並行消費・本文/画像/URL/投稿先の改ざんを拒否する。
発行済み操作は確認票期限や確認票の消去に依存せず、再ログイン後も同じ保存結果で再開できる。
保存失敗で送信しない。結果不明・5xx・タイムアウト・receipt異常の自動再送を追加しない。
別操作としての再投稿は既存の明示確認を維持する。

## 取得境界

初期HTMLホスト: `realescapegame.jp`, `www.scrapmagazine.com`。
画像ホストはそれぞれ元HTMLホストと完全一致。CDN登録は現時点でゼロ。
公式性は [SCRAPのリアル脱出ゲーム公式サイト](https://realescapegame.jp/) と [SCRAP公式サイト](https://www.scrapmagazine.com/) を2026-10-13に確認した。
未確認の別ホスト/CDNは画像なし。URL入力・meta・redirectで許可リストを拡張しない。
この限定リストでは多数の他社サイト・別SCRAPドメインの画像が取得されない。本文投稿は可能。

- HTTPS/実効443、ホスト完全一致。userinfo、IP literal/IPv4別表記/IPv6、内部名、末尾ドット、エンコードauthority、非ASCII authority、backslashを拒否。
- 最大2048文字。fragment除去。画像queryはすべて拒否し、署名URL・秘密URL・期限付きURLをEmbedへ残さない。
- 受信Requestを複製せず、Acceptだけを持つ専用GET。Authorization/Cookie/Bot/OAuth/Referer/Idempotency-Keyを外部へ渡さない。
- manual redirectで各転送先を再検証。各取得最大2転送。ループ・Location欠落・許可外転送を拒否。
- HTML text/html・読み取り後256KiB、画像2MiB。Content-Lengthを信用せずstream byte数で制限。
- HTML解析と最大8画像候補は全体5秒。サムネイルは独立5秒。abort/reader.cancel/releaseLockを実施。
- HTMLRewriterのhead metaのみを読む。og:image候補を先に評価し、失敗すればtwitter:imageへ進む。base/JS/iframe/meta refreshは追跡しない。
- MIMEとmagic bytesを検査。SVG/HTMLを拒否。ブラウザ側でも画像デコード失敗ならnull確認へ切り替える。
- 外部取得を行うpreviewとthumbnailで共有10回/分・同時2件、20秒lease。終了を失っても期限で回収。
- 許可外URL・公式URLなし・null切替は外部取得せず、取得leaseを消費しない。確認票は最大200件・10分、alarm/呼び出しで回収する。
- 外部通信はDOのqueue/transaction外。DOは短い予約・確認票・状態操作だけ。

## 接続先に関する限界

Workers fetchは実際のpeer IPをアプリへ公開せず、DNS解決先をこの実装から固定して検証できない。
URLのホスト検査だけで任意ドメインのDNS rebindingまで防げるとは主張しない。
管理主体を確認した安定した公開公式ホストに限定し、任意利用者所有ドメイン・共有CDNは一切許可しない。
許可ホスト自体のDNS/運営の侵害まで含む完全防御には、接続先を固定できる別のネットワーク境界が必要。
新しいホストの追加時は所有者・公開接続先・CDN関係の再調査を要する。
Cloudflare compatibility flagや設定は変更していない。

保存するのは画像選択結果とURLで、画像バイトの永続同一性ではない。
Discordが後から画像を取得する際のDNS/redirect/変更/期限切れは固定できない。
本文と公式URLを残し、画像がDiscordで表示されなくても自動で別投稿を送らない。

## 検証結果

全外部通信をfixture内で置換。OAuth/Discord/公式HTML/画像の実通信ゼロ。実Secret不使用。

| 検証 | 結果 |
| --- | --- |
| npm test | PASS: 141件。既存129件 + 新画像12件 |
| test:worker-runtime | PASS: OAuth2本人ログイン、旧認証拒否、失効、並行callback/handoff |
| test:post-runtime | PASS: SQLite永続sending、同一キー並行1回、全体投稿制限、再起動、unknown再送なし、read-only |
| test:migration-runtime | PASS: 旧DO状態/署名/receipt保持、新セッションと再起動 |
| test:image-runtime | PASS: 実HTMLRewriter、entity/属性順/大小文字/相対URL/og優先/twitter fallback/head外/base無視、サイズ上限。実SQLiteで確認票CASと12並行1投稿、外部再取得0 |
| test:browser | PASS: 22件。既存認証/投稿/二重送信防止/2タブ/履歴/端末保存失敗など |
| test:image-browser | PASS: 7件。Blob/CSP、thumbnail危険転送、編集競合/URL revoke、期限/認証、320/390/1280px、キーボード |
| test:phase2-browser | PASS: 旧Webhookタグfixture。画像受け入れの代用ではない |
| 本番CPU時間・本番メモリー上限・実DNS/接続先・Discord画像表示 | NOT TESTED |
| mainマージ・Pages/Worker公開・Secret/設定・Portal変更・実投稿 | 未実施 |

ローカルworkerdではアプリの時間・サイズ・件数制限を実行したが、本番のCPU quota/メモリーquotaの強制を再現したとは主張しない。
ブラウザ画面は`work/phase2-images/{320,390,1280}.png`へ保存（Git対象外）。

## 変更ファイル

- 新規worker/src: official-image-policy.mjs、official-image-fetch.mjs、image-preview-ticket.mjs、image-preview-state.mjs、image-preview-handler.mjs。
- 既存worker/src: forum-input.mjs、post-keys.mjs、post-state.mjs、post-handler.mjs、forum-posts.mjs、index.mjs。
- UI: app.js、poster-client.js、index.html、styles.css。
- テスト: worker/tests/image-preview.test.mjs、image-runtime-entry.mjs、image-runtime.mjs、tests/image-browser.cjs。tests-acceptance.cjsとtests/browser-acceptance.cjsへ認証済み画像確認を反映。
- 文書/実行: package.json、README.md、worker/docs/phase3/API-CONTRACT.md、本書。
- wrangler設定、binding、migration、OAuth実装、鍵は変更なし。

参考仕様: [HTMLRewriter](https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/)、[Request](https://developers.cloudflare.com/workers/runtime-apis/request/)、[Forum API](https://docs.discord.com/developers/resources/channel#start-thread-in-forum-or-media-channel)。

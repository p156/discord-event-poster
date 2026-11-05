# 標準リンクEmbed優先と追加画像添付（2026-11-05）

ローカル実装のみ。本番反映・実投稿は行っていない。

## 技術的実現性

Discordのフォーラム作成APIは`message.content`とファイルを同時に受け付ける。multipart/form-dataの`payload_json`にはname、message、applied_tagsを、`files[0]`には画像バイトを送る。message.attachmentsは`[{id:0,filename:"official-image.png"}]`の形でファイルと対応させる。拡張子は検証済みMIMEに応じてpng/jpg/gif/webpとする。

独自embeds・flags・componentsは送らない。本文URLは維持する。API上で添付とリンクを併用でき、添付が標準プレビューを抑制するとの規定は公式文書に見つからなかった。ただし公式仕様は添付時のクライアント表示・リンクプレビュー生成成功を保証していない。実Discord表示の共存可否は未検証。ローカルテストは抑制要因を送らないこととファイル・本文を同時に送れることまでを確認している。

公式資料（find-docs / Context7で確認）：
- https://github.com/discord/discord-api-docs/blob/main/developers/resources/channel.mdx
- https://github.com/discord/discord-api-docs/blob/main/developers/reference.mdx
- https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx

## 実装

1. 署名付きプレビュー、操作キー、凍結画像URLとの照合は既存のまま。
2. Durable Objectでsendingと投稿枠を保存・確定した単一の送信者だけが画像を再取得する。並行要求は取得も投稿も増やさない。
3. 画像取得は既存fetchThumbnailを使用。許可ホスト、リダイレクト各段の検査、認証情報を送らない独立GET、5秒、2MiB、Content-Type、PNG/JPEG/GIF/WebPのmagic検査を維持。SVG等は拒否。許可リストは変更なし。
4. 画像取得・multipart生成に失敗したらDiscordへ書き込む前に通常JSONへ切り替える。送信候補はFormDataをローカルで完全にバイト列化し、生成したboundaryとContent-Typeを対で渡す。
5. 画像があれば単一のフォーラム作成リクエストで本文と画像を送る。追加の画像用メッセージは作らない。
6. 添付付きリクエストがHTTP 400/413で明確に拒否された場合だけ、同じsending・attempt内で通常JSONを1回送る。最初の拒否を含めHTTP要求は2回になり得るが、成功するスレッド作成は1回。各要求は既存共有cooldown経路を通る。
7. 401/403/404・429・redirect・5xx・ネットワーク例外・timeout・不正な成功応答では自動フォールバックしない。結果不明はunknown、再送禁止。400/413後の通常送信が結果不明でも再送しない。429は既存の待機・同一キー再試行規則を維持。
8. OAuth2・タグ取得・固定投稿先・署名とDOの保存形式・停止ゲートは変更しない。

## 検証

- npm test: 175件成功（既存parserチェックも成功）。新規5ケース内で不正画像、サイズ超過、外部ホストredirect、取得例外、対象realdgame未許可、400/413、12並行、結果不明、不正receipt、添付なし送信の応答喪失、ローカルFormData生成失敗を検証。
- npm run test:image-runtime: 成功。実workerdのHTMLRewriter、SQLite DO、12並行単一送信、multipart解析・画像バイト一致、日本語・絵文字本文一致、embeds/flags未指定を確認。
- npm run test:browser: 22ケース成功。認証・タグ・停止ゲート・重複防止・応答喪失・再読込を含む。
- npm run test:image-browser: 13ケース成功。追加した400フォールバックと500再送禁止、320/390/1280幅、本文URL維持を含む。
- すべて外部Discord書き込みはモック。ローカルWorker/ブラウザ起動は通常の制限環境では拒否されたため、ローカル接続・Edge起動が可能な環境で実行。

## 今回の変更ファイル（既存7ファイルとは別）

- worker/src/forum-posts.mjs: 独自Embed削除、画像再検証、安全な添付なしフォールバック。
- worker/src/discord-client.mjs: multipart生成と送信。
- worker/src/post-handler.mjs: 画像用の独立取得経路を渡す。
- worker/tests/image-preview.test.mjs: 添付・失敗・並行・重複防止の回帰検証。
- worker/tests/post-fixtures.mjs: 実ネットワークを禁止した画像取得fixture。
- worker/tests/image-runtime-entry.mjs: multipartを解析して本文とファイルを検証するDiscord mock。
- worker/tests/image-runtime.mjs: workerd/SQLite/日本語本文/添付の検証。
- tests/browser-acceptance.cjs: mock送信内容の観測。
- tests/image-browser.cjs: 添付成功・400通常投稿・500再送禁止のブラウザ検証。
- README.md: 現行方式の説明。
- worker/docs/PHASE2-IMAGE-RESULTS.md: 旧検証記録と現行仕様を区別する注記。
- worker/docs/STANDARD-EMBED-ATTACHMENTS-20261105.md: 本記録。

## 残る限界

- Discord実画面の標準プレビューと添付の共存、リンク取得キャッシュ、権限による表示差は未確認。標準Embed生成そのものの成功はDiscord側次第。
- 対象realdgame.jpは引き続き取得許可外のため追加添付なし。通常URLによる標準プレビューに委ねる。
- 画像バイトは永続保存しない。投稿時に変化・消失した場合は検証済みの現在バイトを送るか、通常投稿へ切り替える。完全デコード検査は追加していない（既存MIME/magic/サイズ検査とブラウザプレビューを維持）。
- 画像取得・送信バイト列の準備による最大5秒程度の待機とメモリ負荷が加わる。本番CPU/メモリ上限での実測は未実施。
- 結果不明時は二重投稿回避を優先し、通常投稿の成功を保証するための再送はしない。

既存未コミット7ファイルは別途SHA-256照合で保全する。本番Worker・Cloudflare設定・Secrets・FORUM_POSTS_ENABLED・main・Pages公開元は変更せず、コミット・push・デプロイしない。

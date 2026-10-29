# Bot / Forum のOwner読み取り照合

本番NO-GO。既存release gate、Workers Logs、本番コード・設定は変更しない。
基準HEADは `816001128e640ef3a2fdb72fd39032994ea7a2cc`（2026-10-29 remote確認）。

## Ownerの次の操作

1. 信頼できるローカルコンソールでソースとNode実行環境をレビューする。画面共有・録画・transcript・デバッガー・入力採取やクラッシュダンプのない環境を使う。非表示入力が機能することを秘密でないテスト入力で事前確認する。自動試験では実コンソールの非表示を保証しない。
2. repoルートで `powershell -NoProfile -File .\worker\tools\owner-discord-readonly.ps1` を手動実行する。実行ポリシーが拒否したら停止し、回避・変更しない。以前のCloudflare入力器はAuthorizationManagerに拒否されたため、同環境で動くと断定しない。
3. `READ` を明示入力して接続を許可し、既存Bot Tokenを非表示プロンプトへ入力する。新規発行・resetは行わない。チャット、引数、ファイル、環境変数にTokenを入れない。安全に使える既存Tokenがなければ停止する。
4. 成功JSONだけを確認する。共有・保存する場合もこの投影済みJSONのみをGit対象外の `work/` へ手動保存する。生応答・stderr・例外を調査目的でも表示しない。

入力はメモリーから匿名stdinへ渡す。引数と環境には渡さずNode hook/debug環境を除去する。不変文字列やOSメモリーの完全消去は保証できない。失敗出力は固定語彙のみ。

## 証明できる範囲

固定 `https://discord.com/api/v10/users/@me` で `bot=true` とBot ID `1319011620185309265`、続いて固定 `/channels/1554204439521398794` でID・guild `1282386566450380871`・type=15を照合する。最大2 GET、各10秒・64KiB、redirect拒否、retryなし。既存discord-client.mjsを再利用し、429も中断する。書込・投稿・Cloudflare接続はない。

PASSは「ローカル入力Tokenが既知Botとして固定Forumを取得できた」だけ。Application専用endpoint、roles/member/overwrite、timeout、タグ、実効5権限を取得・計算しない。既確認のDiscord画面証拠は別資料として保持する。投稿成功を意味しない。

`workerTokenIdentity`、`workerForumIdentity`、`botForum` は常にNOT VERIFIED。releaseEligibleとproductionGoは常にfalse。既存release preflightへ自動投入しない。

## Worker Secretとの間に不足する証拠

既存CloudflareツールはSecret名とmetadataを読むだけで、値との一致を証明しない。今回も既存Secretを読み戻す経路は実装しない。安全な設定記録はこの調査で見つかっていない。秘密ファイルやToken探索は行っていない。

次は、Ownerが秘密を開示せず、両bindingを対象Worker・environment・稼働Versionへ束縛した既存設定時証拠を持っているか確認する。Token resetや後続変更がないことも必要。単なる設定日時、Secret名、同じBot ID、ローカルTokenのPASSだけでは同じToken値を証明しない。

記録がなければNOT VERIFIEDを維持する。将来の別案は、稼働Secretを内部で利用し結果を固定IDの一致判定だけに縮約する、認証・観測保護をレビュー済みの経路。現状その安全な実行経路は未証明で、追加・deploy・実行には別の明示承認が必要。今回の許可では実施しない。Secret変更による再設定で一致したことにしない。

## 検証

`node --test worker/tests/owner-discord-readonly.test.cjs`

偽Token・mockのみ。実Token入力・実API接続なし。既存release gateは別途回帰試験する。API仕様はContext7の `/discord/discord-api-docs` と公式資料を参照：

- [Get Current User](https://docs.discord.com/developers/resources/user#get-current-user)
- [Get Channel / Channel types](https://docs.discord.com/developers/resources/channel)

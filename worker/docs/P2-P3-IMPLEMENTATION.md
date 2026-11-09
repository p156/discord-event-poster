# P2とP3の統合実装

更新日：2026-11-09

## 実装した動作

P1のURL抽出と地域なし解析を維持し、複数フォーラムの登録、切り替え、登録解除と、選択先のBot投稿履歴を追加した。
OAuth2は従来のidentifyとユーザーID完全一致を維持する。
登録情報と最後の選択はブラウザに依存せず、既存のSQLite-backed AuthStateに保存する。

履歴はDiscordを正本とし、このBotが作成したアクティブスレッドと公開アーカイブの最初のメッセージだけを取得する。
owner_idと最初のメッセージのauthor.idで対象を確認し、他人のスレッドと返信は取得対象から外す。
本文が削除された状態、チャンネル削除をAPIで確認した状態、権限や通信のため取得できない状態を分ける。

タイトル比較はNFKC、小文字化、空白と記号の除去、地域付き見出しの除去を行う。
正規化後の完全一致、4文字以上の包含、文字bigramのDice係数0.72以上を重複候補とする。
第5回と第6回などは回数を保持し、同じ催しでも別開催の可能性を表示する。
類似度は21件の新規単体／統合ケース内の具体例で検証した初期値であり、意味的な同一イベント判定を保証しない。

重複候補と履歴取得失敗は警告のみとする。
履歴が未取得、部分取得、取得不能なら「重複未確認」と表示し、その状態だけで投稿を拒否しない。
公式URLは履歴本文から補助情報として保存するが、URL一致を投稿の必須条件にはしない。

## API

全APIで既存のHost、Origin、Bearerセッション境界を維持する。
新規公開APIから任意のDiscord APIパスを指定することはできない。

| API | 用途 |
| --- | --- |
| GET /api/forums | 登録一覧と最後の選択を取得 |
| POST /api/forums/register | forumIdを再検証して登録 |
| POST /api/forums/select | forumId、expectedRevision、expectedGenerationを検証して選択 |
| POST /api/forums/remove | 登録解除。Discord DELETEは呼ばない |
| POST /api/discord/guilds | Bot参加サーバーをafterでページ取得 |
| POST /api/discord/forums | 指定guildIdの利用可能なフォーラムを取得 |
| GET /api/forums/{id}/tags | 選択先の全available_tagsを取得 |
| POST /api/forums/{id}/history/read | 履歴を100件ずつ取得。afterで続きを表示 |
| POST /api/forums/{id}/history/sync | 同期の1段階を実行または再開 |
| POST /api/forums/{id}/history/compare | 指定titlesの重複候補を取得 |
| POST /api/forums/{id}/post-intents | 投稿先を固定して既存操作を発行 |
| POST /api/forums/{id}/posts | 固定済み投稿先へ既存プロトコルで投稿 |
| GET /api/forums/{id}/posts/{operationId} | 登録解除後も署名済み操作を照会 |
| POST /api/forums/{id}/image-preview | 投稿先と登録世代に結び付いた画像確認 |
| POST /api/forums/{id}/image-thumbnail | 同じ投稿先の確認チケットで画像を取得 |

旧/api/forum系APIと旧操作キーの形式を維持する。
旧形式の新規投稿にも公開Workerで本人とBotの権限確認を適用する。
旧ブラウザ操作の再利用判定は元の固定フォーラムに対応付け、別フォーラムの同じ本文を誤って既存操作と扱わない。

## 永続化と移行

既存Storage APIを拡張し、SQLテーブルや外部DBは追加していない。
AuthStateのクラス名、namespace、personal-auth-v1というDO名、既存の認証キー、投稿記録、署名ドメインを維持する。

| キー | 内容 |
| --- | --- |
| forums:registry:v1 | 登録一覧、解除済み記録、登録世代、最後の選択 |
| history:v1:{forumId}:sync | 同期段階、日時カーソル、世代、短命lease、部分取得状態 |
| history:v1:{forumId}:row:{threadId} | タイトル、比較用タイトル、日時、リンク、本文取得状態、補助URL |
| history:v1:{forumId}:pending:{threadId} | 再起動後も処理を続ける本文取得待ち |

最初の管理API利用時に既存のDISCORD_FORUM_CHANNEL_IDを一度だけ初期登録する。
その後は登録レコードを削除せず解除状態と世代を保存し、解除済みフォーラムの自動再登録を防ぐ。
選択先を解除すると選択を空にする。
既存操作に追加したforumGenerationで、解除して再登録した後の未送信操作の流用を拒否する。
送信開始済み操作の結果記録と照会は妨げない。

DO内では短い状態更新だけを直列化し、Discordのネットワーク取得はDOの認証キュー外で行う。
履歴同期はleaseで重複実行を防ぎ、途中の429や通信失敗ではカーソルを保持する。
1回に最大2件の本文を処理し、画面では最大20段階を続けて取得する。
続きがある場合や失敗した場合は取得ボタンで再開できる。

## 投稿先を混線させない仕組み

- 新規APIのURL、署名済み操作のforumId、DOの登録世代を照合する。
- 操作発行後に選択先が変わっても、送信と結果照会は操作の元のforumIdを使用する。
- フォーラム変更時にタグ、画像確認、投稿確認、履歴、重複候補を破棄する。
- タグはIDで保持し、投稿前に現在のavailable_tagsと照合する。
- 管理対象タグのMANAGE_THREADS検証と、既存の最大5タグ制限を維持する。
- 自動タグ判定は既存8分類の名称が選択先に存在する場合だけ適用する。
- 遅れたAPI応答は画面のフォーラム世代と照合し、別投稿先の応答を破棄する。
- 画像チケットはforumIdに加え登録世代にも結び付ける。
- 既存のsending永続化、冪等キー、結果不明時の自動再送禁止を維持する。

## Discord側の条件

本人とBotのサーバー所属、チャンネル実効権限をBot APIで確認する。
新規フォーラム投稿にはVIEW_CHANNELとSEND_MESSAGES、履歴にはVIEW_CHANNELとREAD_MESSAGE_HISTORYが必要になる。
画像にはATTACH_FILES、管理対象タグにはMANAGE_THREADSが必要になる。
履歴のREAD_MESSAGE_HISTORY不足だけでは投稿を停止しない。
タイムアウト中の本人またはBotによる投稿は拒否する。

履歴を自Bot投稿だけに限定したため、この機能のためのMESSAGE_CONTENT有効化やguildsスコープ追加は不要である。
Bot TokenとOAuth2シークレットはWorkerから外へ返さない。
Botの権限、Cloudflare本番設定、OAuth2設定はこの変更で操作していない。

根拠：

- [Discordのスレッド列挙](https://docs.discord.com/developers/topics/threads#enumerating-threads)
- [公開アーカイブの取得](https://docs.discord.com/developers/resources/channel#list-public-archived-threads)
- [チャンネルの実効権限取得](https://docs.discord.com/developers/resources/channel#get-channel-member-permissions)
- [Message Contentの自アプリ投稿の例外](https://docs.discord.com/developers/events/gateway#message-content-intent)

## 制約

Discordの履歴APIは同時点のスナップショットではないため、同期中の追加や編集に対する厳密な完全性は保証しない。
再取得で現在のDiscord状態へ近づける。
APIの429と取得不能は部分取得として表示し、削除と断定しない。

アーカイブ日時境界は1ミリ秒重ねて読み、同じIDを除外する。
同一時刻に多数のアーカイブが集中して日時カーソルが進まない場合は部分取得にとどめ、重複確認済みとは表示しない。
削除済み行は履歴に状態を表示するが重複候補には含めない。

履歴表示は100件ずつ、比較は最大100タイトル、1タイトルの表示候補は類似度順20件、1回の比較走査は最大10,000行である。
比較上限を超えた場合も「重複未確認」を維持する。
Discordの読み取りレスポンスは1MiBを上限とし、上限超過では未確認状態にする。
大量の参加サーバーやフォーラムでは取得に時間がかかるため、失敗した一覧取得は再実行が必要になる。
巨大Botの特殊なlarge sharding環境で必要なshard指定はAPIで受け付けるが、画面からの全shard自動探索は対象としていない。

## 検証

- npm test：218件成功、失敗0。従来のparserチェックも成功。
- 拡張テスト：295件中281件成功、14件失敗。
- 拡張テストの失敗名14件はP1時点のログと照合し、完全一致を確認。
- 既存のブラウザ22ケース、旧画面14ケース、旧Phase 2ブラウザ、認証runtime、投稿runtime、移行runtime、画像runtime、画像ブラウザが成功。
- 新規ブラウザ7ケースと、SQLite再起動と再ログインを含むP2/P3 runtimeが成功。
- すべてのDiscord投稿はモックであり、実投稿は行っていない。

既存14失敗はowner-readonly-evidence、staging-artifacts、wrangler-stage1-deploy、wrangler-strict-candidateに属する。
固定されたローカル作業場所や成果物、未同梱のworker/work/wrangler-strict-validation/wrangler.jsonc等への依存は変更していない。
全テスト成功とは扱わない。

## マージ前レビュー4件への対応

修正基準は27703439f67e82f11239eb0576eba45334b1bc83である。
マージ可否は修正後の再レビューで判断する。

1. 旧操作のforumGenerationが欠落または0の場合は初期登録世代1に対応付ける。
   初期登録中は旧操作を維持し、解除して再登録した世代への流用はreserveとbeginで拒否する。
   送信済みと結果不明の操作の照会を維持し、結果不明を自動再送しない。
2. 履歴処理の欠落フラグは成功経路と失敗経路の両方で保存する。
   完了時にも保存行を確認し、pending、body_deleted、unavailableが残る場合は部分取得とする。
   旧バージョン等の不整合な完了記録でも、比較時に保存行から重複未確認と判定する。
3. 選択APIは期待するregistry revisionと対象の登録世代を必須にする。
   DO内の直列化区間で照合し、古いrevisionはSELECTION_CONFLICT、別の登録世代はTARGET_CHANGEDで拒否する。
   画面は最新の選択要求だけを処理し、無関係な登録更新との競合では登録世代が変わっていない場合に限り最大3回試す。
   解除や再登録があればその要求を再試行せず、保存された選択を再取得する。
4. 地域とタイトルの間にLFまたはCRLFがあっても地域を保持する。
   行頭制約と地域なしの解析を維持し、本文途中の引用と引用記号に続く行を新イベントにしない。

通常テストには回帰11件を追加した。
欠落／0の旧操作、初期登録時の互換性、解除後の拒否、過去結果の照会、本文取得不能と429の同時発生、DO再起動、欠落行と完了状態の整合性、選択revisionと登録世代の競合、改行付き地域を検証する。
ブラウザには逆順の選択要求、別操作による解除と再登録、無関係な登録更新後の再試行の3ケースを追加した。
SQLite runtimeでも429前の欠落状態を保存して再起動し、再開後に部分取得と重複未確認を保つことを確認した。

画像ブラウザは一括実行中にローカル接続のECONNRESETで終了したため、単独で再実行し全ケース成功した。
この接続切断をコード上の画像回帰と断定していない。
認証、画像処理、Cloudflare設定、Bot権限設定をこの修正で変更していない。

## 変更ファイル

- `app.js`
- `index.html`
- `package.json`
- `poster-client.js`
- `styles.css`
- `tests/browser-acceptance.cjs`
- `tests/p23-browser.cjs`
- `worker/docs/P2-P3-IMPLEMENTATION.md`
- `worker/src/discord-client.mjs`
- `worker/src/discord-cooldown-state.mjs`
- `worker/src/discord-cooldown.mjs`
- `worker/src/forum-access.mjs`
- `worker/src/forum-history.mjs`
- `worker/src/forum-management.mjs`
- `worker/src/forum-posts.mjs`
- `worker/src/forum-registry.mjs`
- `worker/src/forum-tags.mjs`
- `worker/src/image-preview-handler.mjs`
- `worker/src/image-preview-ticket.mjs`
- `worker/src/index.mjs`
- `worker/src/post-handler.mjs`
- `worker/src/post-state.mjs`
- `worker/src/title-match.mjs`
- `worker/tests/forum-posts.test.mjs`
- `worker/tests/image-runtime-entry.mjs`
- `worker/tests/management-mock.mjs`
- `worker/tests/p23-discord-mock.mjs`
- `worker/tests/p23-runtime-entry.mjs`
- `worker/tests/p23-runtime.mjs`
- `worker/tests/p23.test.mjs`
- `worker/tests/post-runtime-entry.mjs`

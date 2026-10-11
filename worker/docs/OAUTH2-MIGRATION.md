# Discord OAuth2認証と本番移行手順

event-poster-v2での開発仕様。本番設定・Secret・Developer Portalは変更していない。

## 認証契約

| 経路 | 契約 |
| --- | --- |
| POST /api/oauth/start | 固定Host・フロントOrigin・urlencoded challengeのみ。トップレベルpopup内フォームで開始。303でDiscordへ |
| GET /api/oauth/callback | このGETだけOrigin不要。固定Host、state、フロー専用Cookie、期限、一回限り消費を検証 |
| POST /api/oauth/complete | 固定Origin、JSONのhandoff/verifierのみ。一回限りのチケットと開始タブの証明でアプリセッション発行 |
| GET /api/session | 新OAuth2アプリBearerのみ。投稿能力情報を返す。寿命を延長しない |
| POST /api/logout | DOの新セッションを失効。操作履歴は消さない |
| POST /api/login | 廃止。404、AUTH_METHOD_REMOVED。パスワードや旧Bearerへのfallbackなし |

Discord scopeはidentifyだけ。WorkerがAuthorization Code Grantでコードを交換し、users/@meのidをDISCORD_ALLOWED_USER_IDと文字列で完全一致比較する。
Discordアクセストークンとrefresh tokenは保存もフロントへの返却もしない。投稿は引き続きBot名義。
アプリセッションは発行時から3,600秒、延長なし。20セッションまで保持。期限・署名・DO存在・本人IDを各認証時に検証し、投稿直前のDO transaction内でも再検証する。

## 一時情報と公開フロント

- state・Cookie nonce・開始タブverifierはそれぞれ256ビット乱数。開始フローは5分。
- フロー単位の__Host- CookieをSecure / HttpOnly / SameSite=Lax / Path=/で設定。完了時に削除。
- stateはDOで原子的に消費してから外部通信。同じstateの並行callbackは一度だけ受理。
- 本人確認後のhandoffは60秒・一度だけ。DOにはhandoffのハッシュとverifier challengeだけを保存。正しい長さの失敗verifierでの試行もチケットを消費する。
- callbackは固定ALLOWED_ORIGINにpostMessage。開始タブはWorker originと開いたpopupのwindow参照を完全一致確認してからcompleteへ送る。
- 外部通信はDOの共有投稿キューの外で行う。OAuth処理を待って投稿状態の処理を長時間塞がない。
- 開始は5分20回、callbackは5分120回、completeは5分60回のDO共有制限。未完了フロー・handoffもそれぞれ20件に制限。
- OAuth token/users通信は固定URL、redirect:manual、各通信5秒、JSON16KiBまで。3xx、非JSON、不正token/scope/IDは拒否。
- start/completeの入力は4KiB・5秒まで。callback queryは指定項目だけで重複不可。
- callbackはno-store/no-referrer/nonce CSP/frame-ancestors noneで保護。codeとstateを画面履歴から除去。外部資産は読み込まない。
- フロントはCSPでスクリプトをself、API接続を固定Worker、フォームの行き先をWorkerとDiscord認可先へ限定。
- フロント文書のReferrer-Policyはstrict-origin。no-referrerだとブラウザがトップレベルフォームPOSTのOriginをnullにし得るため、開始フォームのOrigin検証を保つ。URLのパス・queryは送らない。callbackとAPI fetchはno-referrer。
- app sessionだけをdiscord-event-poster.session.oauth2へ保存。JSが読めるBearerのためXSS対策が必要。解析結果はエスケープし、外部scriptを導入しない。
- ポップアップが遮断・閉じられた場合やCookieが使えない場合は失敗表示し、投稿しない。編集済み本文は元タブに残す。

## 既存データの移行

維持するもの: AUTH_STATE / AuthState / personal-auth-v1 / auth-v1 migration、SESSION_SIGNING_KEY、personal-owner-v1、操作キーv1、payload hash、posts:*、Discordクールダウン、FORUM_POSTS_ENABLEDの3モード。
新認証はAUTH_SESSION_SIGNING_KEYとapp-session:oauth2:v1署名ドメイン、oauth2.形式、新DO保存領域auth:oauth2:sessionsを使用する。既存署名鍵と同じ値を設定すると拒否する。
初回のDO認証処理で旧sessions/attemptsをtransaction内で削除し、移行マーカーを保存。旧セッションは形式検証でも常に拒否する。
フロントは旧discord-event-poster.sessionだけを削除する。operations.v1は保持し、本人の再ログイン後に照会を継続する。
旧パスワードに対応するSecretを含め、既存Cloudflare Secretsは一切削除しない。Wrangler必須名からのAPP_PASSWORD_HASH撤去は本番Secretの削除ではない。
alarmは認証・一時情報・投稿期限を共存して掃除する。sending/unknownは自動再送しない。

## 必要な本番設定（後日の明示承認対象）

| 名前 | 設定 |
| --- | --- |
| DISCORD_OAUTH_CLIENT_ID | 既存Bot ApplicationのClient ID。認可URLには現れるが公開フロントへ埋め込まない |
| DISCORD_OAUTH_CLIENT_SECRET | OAuth2のClient Secret。Bot Tokenとは別。Cloudflare Secret |
| DISCORD_ALLOWED_USER_ID | 本人のDiscordユーザーID。Cloudflare Secret、公開リポジトリへ書かない |
| AUTH_SESSION_SIGNING_KEY | 新規の十分な乱数、64文字以上。既存SESSION_SIGNING_KEYとは別。Cloudflare Secret |
| DISCORD_OAUTH_REDIRECT_URI | https://discord-event-poster-api.monma5435.workers.dev/api/oauth/callback とPortal登録値を完全一致 |

上記はWranglerのrequired secretsにも登録する。値はチャット、GitHub、公開bundle、ログ、スクリーンショットに載せない。
既存ALLOWED_ORIGIN / DISCORD_BOT_TOKEN / DISCORD_FORUM_CHANNEL_ID / SESSION_SIGNING_KEY / APP_PASSWORD_HASH等は保持する。
Discord Developer Portalの既存Application > OAuth2でRedirect URIを登録する。ログイン要求はidentifyのみ。Bot再作成・Token再生成・追加招待は不要。
実設定前にApplicationとWorkerの対象環境を再確認する。

## 本番反映の順序

以下は実行手順案であり、今回の実装承認には含まれない。

1. 開発コミットと検証記録を確認する。mainへのマージ、Portal設定、Secrets変更、本番反映の承認範囲をそれぞれ確認する。
2. 既存DO・既存投稿署名鍵・投稿先・フロントOrigin・稼働Version・停止モードを読み取り確認する。秘密値そのものを報告しない。
3. 承認されたPortalのRedirect URIを設定する。OAuth2アプリ情報をCloudflareの安全な入力経路で設定する。既存Secretsは削除しない。
4. コードと必要Secretを整合したVersionとして反映する具体的な方法を事前確認する。通常のwrangler secret put/deleteは即時デプロイを伴うため、準備操作として実行しない。
5. 承認された停止モードread-only等でWorkerとフロントを反映する。DO binding・class・name・migrationは変更しない。
6. 旧PW経路404と旧Bearer拒否、新ログインの本人限定、ログアウト失効を実環境で確認する。実OAuthログインはこの段階の別承認対象。
7. 既存操作キーによる状態GETとDiscordリンク、unknown/sendingの非再送を確認する。実投稿なしで確認可能な範囲を先に検証する。
8. 投稿有効化・実投稿は別承認。必要な場合に限り最小の1件で確認する。

旧コードへのロールバックはPW認証を復活させ得る。障害時はまず承認された投稿停止を行い、新認証を維持した修正版へ戻す。DOや署名鍵を消して復旧しない。

## ローカル検証と残課題

テストはダミー値だけを使用。Discordのtoken/users APIと投稿APIは完全モック。Miniflare dispatchFetchはOAuthのredirectを追わず、ブラウザでのDiscord認可画面もモックする。
試験中に補助処理がstartのredirectを追う問題が判明し、manualに修正。最終検証はこの修正後の結果だけを採用する。
途中試験では公開DiscordログインページのGET取得が発生した。使用値はすべてダミーで、実コード交換・実ログイン・Bot投稿は行っていない。修正後の試験は外部通信をモックしている。
ブラウザ試験はWorkerの実303とCookieを検証した後、Playwrightのredirect interception制約を避けるため新規ナビゲーションとして各ホップをモックする。Discordの実画面や実ヘッダーの検証にはならない。
旧Stage 1の実行wrapperは当時のconfig/Versionを固定しており、OAuth設定には適合しない。安全境界を緩めず保持している。本番反映前にOAuth用の具体的な適用手順を別途承認し、旧wrapperをそのまま実行しない。
本番Secret、Portal設定、実OAuth、実Discord投稿、公開Pagesの配信一致は未検証。
ブラウザのopener/Cookie制限やDiscord側ヘッダーが実環境でどう働くかは、本番移行承認後に実OAuthで確認が必要。
一般identifyフローのDiscord PKCE対応は確認していないため、Social SDK用の例を流用しない。アプリhandoffのverifierは独立した保護である。

仕様根拠: https://docs.discord.com/developers/topics/oauth2 、https://developers.cloudflare.com/workers/configuration/secrets/

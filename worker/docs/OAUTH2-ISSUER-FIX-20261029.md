# OAuth2 issuer互換性修正（2026-10-29 JST）

開始時のGitHub/local event-poster-v2 HEADは両方ともcd7f000a4e611d08cc5e86b76745a1c14c9d955d。作業ツリーはclean。

## 根拠と変更

[Discord公式OAuth2仕様](https://docs.discord.com/developers/topics/oauth2#issuer-identification)は認可応答にiss=https://discord.comが含まれると定める。Context7の公式discord-api-docs取得結果とも一致した。
修正前に追加回帰テストを実行し、正規issuer付きcallbackの期待200に対して400を再現した。

callbackの許可キーにissを追加し、存在する場合はURLSearchParamsによるデコード後の値をhttps://discord.comと完全一致で検証する。URL正規化・部分一致・動的discovery・issuer宛て通信はしない。
検証位置はstate消費とコード交換より前。空値、不正issuer、重複キー（エンコードした同名キーを含む）、未知キーを400で拒否する。正規issuerは認証の証明ではなく、従来のstate/Cookie・本人ID・handoff検証も必須。
固定Discord単独providerという従来構成を保ち、issなしcallbackは引き続き受理する。issuer必須化や他provider対応は今回の変更範囲外。
error/error_descriptionを含む取消応答は正規issuer付きでも従来どおりフローを消費して拒否する。未知キーの拒否と、既知キーの従来の組合せ処理は維持する。

既存フローは機密クライアントのcode交換と固定redirect_uri、identifyスコープ、本人ID照合を使う。stateはHttpOnly/Secure/SameSite=Lax Cookieに結び付けられ一度だけ消費される。タブのchallenge/verifierはhandoffを保護する独自の証明であり、Discordのtoken endpointへcode_verifierを送るPKCEではない。この設計は変更しない。

## 検証

- OAuthテスト23/23 PASS（既存18件＋追加5件）。正常issuerで完了・再利用拒否・タブ証明不一致、13種の不正issuer、7種の重複/未知query、state/Cookie拒否、取消を検証。
- npm test: 146/146 PASS、および先行parser検査PASS。OAuth23件は146件に含まれる。
- bundled workerd + SQLite DO認証シナリオPASS。
- SQLite永続化を使う旧認証からOAuth2へのmigrationシナリオPASS。
- runtimeは制限環境のlocalhost EACCES後、許可されたローカル通信環境で再実行してPASS。Discordはmockで、実認証・実投稿なし。
- git diff --check PASS。

共通ログインfixtureにも正規issuerを加え、回帰・runtimeが公式応答形式を通るようにした。issuerなしの既存OAuth単体テストも維持した。

## 残る制約

本変更は本番GOを意味しない。実OAuth、Cloudflare設定、Secrets、Worker/Pagesデプロイ、受付停止、実Discord投稿、main変更は行わない。
本番adapter・安全なSecret入力・管理API metadataと全module hash・実効上限・Bot/forum権限・停止/復旧候補・callback観測保護など、実行票の未検証/NO-GO事項は残る。
コード変更により旧候補bundle/hashは新しいコードの証拠にならない。新候補の生成・hash照合と本番前再審査が必要。

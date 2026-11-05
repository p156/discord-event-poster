# GitHub Pages公開構成レビュー

確認日：2026年11月5日（日本時間）。
対象：`p156/discord-event-poster` の `event-poster-v2`。

タイムアウトの内部原因は未確定。
ビルド成功後のPages配信処理が完了しないことは確認できたが、公開ファイルの構成やサイズから、その理由を特定する証拠は見つからなかった。
今回の修正は開発用文書の公開除外に限定し、タイムアウトの解消済みとは扱わない。

## 比較したコミットと実行

ローカルの `main` は `a42177f` だったため、比較にはGitHubで確認した実際のmain先頭 `7ad417f37a6ddb9bd9bf9621c651a8dd89b8883a` を使用した。
mainブランチ自体は更新していない。

| 対象 | コミット | 実行 | 結果 |
| --- | --- | --- | --- |
| main | `7ad417f` | [41893149547](https://github.com/p156/discord-event-poster/actions/runs/41893149547) | ビルド27秒、配信9秒で成功 |
| v2の診断変更前 | `38ddbe2` | [41881886605](https://github.com/p156/discord-event-poster/actions/runs/41881886605) | ビルド23秒、配信133秒で成功 |
| v2の診断変更後 | `bf79051` | [41887743390](https://github.com/p156/discord-event-poster/actions/runs/41887743390) | ビルド成功後、配信タイムアウト |
| 同じv2の新規ビルド | `bf79051` | [41891157088](https://github.com/p156/discord-event-poster/actions/runs/41891157088) | ビルド成功後、配信タイムアウト |

v2にも成功実績があるため、v2全体の構成が常に公開不能だという仮説は支持されない。
ただし、診断変更後の成功をまだ確認できていないため、内容との関係を完全に否定する比較実験にはなっていない。

## 公開構成とソースコード

初回レビュー時のPages設定は `build_type: legacy`、公開元は `event-poster-v2` のルートだった。
追加検証時点では公開元が `main` のルートで、状態は `built` だった。
今回の作業では公開元の変更を行っていない。
mainとv2の両コミットにリポジトリ管理の `.github/workflows` はなく、GitHubが生成する `pages-build-deployment` がJekyllでビルドし、`actions/deploy-pages@v5` で配信していた。
`_config.yml` は両コミットで同一だった。
独自のビルドスクリプト、リダイレクト設定、カスタムプラグインの追加はなかった。

`index.html` が参照するローカル資産は `styles.css`、`poster-client.js`、`app.js` の3ファイルで、すべて成果物に存在した。
参照は相対パスなので、リポジトリ名を含むPagesのサブパスに対応している。
大文字小文字の衝突、特殊リンク、サブモジュール、参照先の欠落は検出されなかった。
CSSには外部CSSのimportや追加画像取得の指定がなかった。

mainからv2へのフロント変更は、OAuth2ログイン、公式URLと画像プレビュー、説明欄の表示、CSP、診断表示が中心だった。
ブラウザで実行するJavaScriptの処理やCSPがPages配信待ちを発生させたことを示すログはない。
GitHub側のビルドは成功しており、Liquidの解析失敗やJavaScriptファイルの欠落も報告されていない。
これらの機能や認証仕様は今回変更していない。

## 成果物の比較

GitHubから実際のZIP成果物を取得し、内包するtarを展開せずに検査した。

| 対象 | ZIPのサイズ | 公開ファイル数 | ファイル合計サイズ |
| --- | ---: | ---: | ---: |
| main成功 | 33,133バイト | 8 | 141,241バイト |
| v2成功 | 36,476バイト | 8 | 152,603バイト |
| v2失敗 | 36,930バイト | 8 | 154,275バイト |

3成果物のファイル名はすべて同じだった。

- `index.html`
- `app.js`
- `poster-client.js`
- `styles.css`
- `README.md`
- `ACCEPTANCE.md`
- `ACCEPTANCE.html`
- `assets/css/style.css`

v2の成功と失敗の差は、診断変更を含むJavaScriptの2ファイルと、生成HTMLのCSS参照に付くコミット番号だけだった。
失敗した成果物のJavaScriptはローカルの診断コミットと一致した。
開発依存、テスト、Workerのコードや設定、作業記録の混入はなかった。

## 最小修正

`README.md` と `ACCEPTANCE.md` はアプリの動作に不要だが、既存設定では公開対象に残っていた。
後者からは `ACCEPTANCE.html` も生成されていた。
開発文書にあるWorker文書へのリンクは、Workerフォルダーの公開除外と整合していなかった。

このため、`_config.yml` の既存 `exclude` に2ファイルを追加した。
除外はJekyllの公式設定に従う。
修正後のローカルJekyll成果物は、後述の追加検証で5ファイルに減ったことを確認した。
`assets/css/style.css` は既存テーマの生成物で、アプリからは参照されていないが、今回テーマ構成までは変更しなかった。

公開後の検証用 `tests/pages-verify.cjs` に、上記文書と生成HTML、Workerソースと設定のHTTP 404確認を追加した。
既存の公開ファイル一致確認と画面確認は維持した。
`.nojekyll` の追加や公開元フォルダーの移動は行っていない。

設定の根拠：[Jekyllの既定設定](https://github.com/jekyll/jekyll/blob/master/docs/_docs/configuration/default.md)。

## 原因判定の限界

失敗した配信は `updating_pages` を繰り返した後にタイムアウトした。
再実行は待機状態で残り、終了要求にはHTTP 409が返った。
GitHubの配信内部状態が関係する可能性はあるが、内部理由を取得できていない。

[同じ症状の利用者報告](https://github.com/orgs/community/discussions/210394)もあるが、今回と同じ原因だという証明にはならない。
[公式のActionsとPages障害](https://www.githubstatus.com/incidents/xr3myzj7ms51)の発生時間には古い待機ジョブの作成時刻が重なるものの、その後mainとv2の両方に成功実績もある。
障害の残存状態が今回の原因だとは断定しない。

## 検証と保護対象

- `npm test`：160件成功、失敗0件。解析スモーク試験も成功。
- `npm run test:browser`：22件成功、実Discord通信0件。
- `node --check tests/pages-verify.cjs`：成功。
- `git diff --check`：成功。
- `index.html`、`app.js`、`poster-client.js`、`styles.css` は診断コミットから変更なし。

公開確認テストの新しい404検証は、追加検証でビルド済み成果物のローカル配信に対して実行した。
本番URLに対する修正後の確認は、公開承認後に残る。

既存の未コミット変更7ファイルは今回の修正対象から除外した。
調査開始時の差分SHA-256は `126B1D1FCECC7F8FE25BA464F1B35756A65A4DB44EA6BDF4B0596A5B6A7D9E4E`。
main、OAuth2診断表示、Workerの本番設定、投稿停止設定は変更していない。
今回の作業ではコミット、push、Pages公開、Workerデプロイを行っていない。

## 修正後のJekyll追加検証

作業フォルダー内の `work/pages-local` にRubyと依存を隔離して導入した。
元の作業ツリーをコピーした105ファイルをビルド元とし、OS全体へのインストールや本番操作は行っていない。
本番ログに合わせて `github-pages 232`、`Jekyll 3.10.0`、`jekyll-theme-primer 0.6.0` を使用した。
`JEKYLL_ENV=production`、`--safe`、`--baseurl /discord-event-poster` でビルドした。
Pages標準プラグインと既定テーマの読み込みをログで確認し、生成処理は0.84秒で成功した。
WindowsとLinuxの違い、および未固定の間接依存があるため、GitHub Actionsコンテナとの完全な環境同一性までは主張しない。

| 公開ファイル | サイズ |
| --- | ---: |
| `index.html` | 4,333バイト |
| `app.js` | 29,562バイト |
| `poster-client.js` | 12,813バイト |
| `styles.css` | 4,824バイト |
| `assets/css/style.css` | 76,559バイト |
| 合計5ファイル | 128,091バイト |

アプリの4ファイルは元の作業ツリーとバイト単位で一致した。
過去のGitHub成果物との一部サイズ差には改行コードの違いがあるため、表の比較を圧縮率やコード変更量の根拠には使わない。
公開成果物にREADME、旧受入記録、Worker、テスト、依存ファイル、検証用環境は含まれていなかった。
特殊リンク、未解決の資産参照、公開パス外への資産参照も検出されなかった。

`tests/pages-artifact-guard.cjs` を追加し、必須4資産と任意の既定テーマCSS以外を拒否する検証を実行した。
不要な文書、Workerフォルダー、欠落や不一致のある資産、サブパス外参照などを拒否する回帰テスト10件が成功した。

`tests/pages-verify.cjs` に検証先URLと証拠保存先の指定を追加した。
既定の本番確認先は変更していない。
修正後の成果物を127.0.0.1だけで一時配信し、次の検証を成功させた。

- 公開4資産の一致確認。
- README、旧受入記録の原文と生成HTML、Workerソースと設定など12パスのHTTP 404確認。
- 幅1280、390、320ピクセルでの解析とプレビュー、横幅、JavaScriptエラーの検証。
- ブラウザからWorkerやDiscordへ通信しないこと。

追加検証時にも `npm test` の160件と既存ブラウザ試験22件は成功した。
公開ガード10件、構文確認、差分チェックも成功した。
保護対象7ファイルの差分SHA-256は初回記録と一致した。
アプリ4資産、診断表示、main、Worker本番設定、投稿停止設定は変更していない。

検証終了時点のPagesは `main` のルートを公開する `legacy` モードで、状態は `built`。
実行中ジョブはなく、v2の待機ジョブ `41887743390` と `41867501560` が残っていた。
これらの終了、再実行、削除は行っていない。

ローカル成果物と公開ガードは成功したため、承認を得たうえで公開検証へ進める状態と判断する。
ただし、過去の配信タイムアウトの原因特定と解消は未確認のままである。
公開する場合は、今回の修正だけをv2にコミットしてpushし、現在mainになっているPages公開元をv2へ切り替える承認が必要になる。
公開成功後には本番の成果物一致と404確認を再実行する。

検証証拠は `work/pages-local/jekyll-pages-build.log`、`work/pages-local/artifact-manifest.json`、`work/pages-local/verification/pages.json`、同フォルダーの画面画像に保存した。

# Discord Event Poster

GitHub Pagesで動作する、複数イベントのDiscordフォーラム投稿ツールです。

## 使い方

1. DiscordフォーラムのWebhook URLを入力する。
2. Xなどからコピーした告知文を貼り付けて「解析する」を押す。
3. 抽出結果を編集し、投稿対象を選ぶ。
4. 投稿内容を確認してからDiscordへ投稿する。

Webhook URLはユーザーが選択した場合だけ、この端末のlocalStorageに保存します。localStorageは暗号化された秘密情報保管庫ではありません。共有端末では保存しないでください。入力文章と抽出結果はページを閉じると消えます。

## 開発

外部ランタイム依存なしのVanilla JavaScriptです。GitHub Pagesではリポジトリの Settings → Pages で `main` / root を選択してください。Project Siteの相対URLで動作します。

## 制約

DiscordのWebhook URLをブラウザに入力する方式のため、URLを知る人は投稿できます。公開リポジトリにはURLを含めないでください。初期版は本文2000文字、スレッド名100文字の範囲を送信前に検証します。解析はルールベースで、認識できない文は警告します。投稿結果が不明な場合は自動再送信しません。

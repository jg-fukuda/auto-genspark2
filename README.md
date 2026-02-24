# Genspark Model Comparator

Genspark の複数 AI モデルに画像 + プロンプトを送信し、回答結果を CSV で比較するツールです。

## 前提条件

- **Node.js v18 以上** がインストールされていること
  - https://nodejs.org/ からインストーラをダウンロードして実行
- **OS**: Windows 10 / 11
- **Genspark アカウント**: ブラウザでログイン済みであること

## セットアップ

```bash
# 1. 依存パッケージのインストール
npm install

# 2. Playwright のブラウザ (Chromium) をダウンロード
npm run setup
```

> **Web Driver について**
> Playwright は独自の Chromium ブラウザを自動ダウンロードするため、
> 別途 ChromeDriver 等の配置は **不要** です。
> ダウンロードされる場所は以下の通りです:
>
> ```
> Windows: %USERPROFILE%\AppData\Local\ms-playwright\
> ```
>
> `npm run setup` を実行すれば自動的にこのディレクトリに配置されます。

## ファイル構成

```
.
├── index.js          # メインスクリプト
├── package.json
├── prompt.txt        # プロンプト本文（※ 編集してください）
├── models.txt        # 使用するモデル名（改行区切り、※ 編集してください）
├── images/           # 比較対象の画像を入れるフォルダ
│   ├── sample1.png
│   └── sample2.jpg
├── dest/             # CSV 出力先（自動作成されます）
│   └── 2026-02-24.csv
└── README.md
```

## 使い方

### 1. 設定ファイルの準備

#### `prompt.txt`
画像と一緒に送信するプロンプトを記述します。

```
この画像に何が写っていますか？詳しく説明してください。
```

#### `models.txt`
使用するモデル名を **1 行に 1 つ** 記述します。
Genspark の UI 上で表示されるモデル名と **完全一致** させてください。

```
GPT-4o
Claude 3.5 Sonnet
Gemini 2.0 Flash
```

#### `images/`
比較したい画像ファイルをこのフォルダに入れてください。
対応形式: `.png` `.jpg` `.jpeg` `.gif` `.webp` `.bmp`

### 2. Genspark にログイン

**実行前に**、ブラウザ（普段使っているもの）で [Genspark](https://www.genspark.ai/) にログインしておいてください。

> 注意: Playwright は独自のブラウザプロファイルで起動するため、
> 初回は Playwright が起動したブラウザ上でもログインが必要です。
> ログイン情報を永続化したい場合は、下記「ログイン情報の永続化」を参照してください。

### 3. 実行

```bash
npm start
```

ブラウザが自動的に起動し、以下の処理が行われます:

1. ログイン状態を確認（未ログインなら中止）
2. 各画像 × 各モデルの組み合わせで順に実行:
   - 新しいチャットを開始
   - モデルを選択
   - 画像をアップロード
   - プロンプトを送信
   - 回答を待って取得
3. 結果を `dest/YYYY-MM-DD.csv` に出力

### 4. 出力結果

`dest/` フォルダに当日の日付で CSV が生成されます。

| 画像ファイル名 | 使用モデル | レスポンス |
| --- | --- | --- |
| photo1.png | GPT-4o | この画像には... |
| photo1.png | Claude 3.5 Sonnet | 画像を分析すると... |

CSV は UTF-8 (BOM 付き) で出力されるため、Excel でそのまま開けます。

## ログイン情報の永続化（オプション）

毎回ログインするのが面倒な場合、以下の手順でセッション情報を保存できます。

```bash
# 1. 手動でログインしてセッションを保存
npx playwright open --save-storage=auth.json https://www.genspark.ai/

# (ブラウザが開くので、Genspark にログインしてからブラウザを閉じる)
```

次に `index.js` の以下の部分のコメントを外します:

```javascript
const context = await browser.newContext({
  // ↓ この行のコメントを外す
  storageState: path.resolve(__dirname, 'auth.json'),
});
```

これにより、保存済みのセッション情報で自動ログインされます。

## トラブルシューティング

### 「停止ボタンが見つかりません」の警告が出る

`index.js` 内に `TODO` コメントがあります。
Genspark の UI 上で、回答生成中に表示される停止ボタンの実際のセレクタを確認し、
`stopButtonSelectors` 配列に追加してください。

確認方法:
1. ブラウザの開発者ツール (F12) を開く
2. Genspark でプロンプトを送信する
3. 回答生成中に表示される停止ボタンを右クリック → 「検証」
4. その要素の class 名や属性をメモする
5. `index.js` の `stopButtonSelectors` 配列に追加する

### モデルが見つからずスキップされる

`models.txt` に記載したモデル名が Genspark の UI 上の表示と **完全一致** しているか確認してください。
大文字/小文字、スペース、バージョン番号も含めて正確に合わせる必要があります。

### テキスト入力欄が見つからない

`index.js` の `sendPrompt` 関数内の `TODO` コメントを参照し、
実際のテキスト入力欄のセレクタを確認・修正してください。

## 注意事項

- Genspark の UI 変更により、セレクタが機能しなくなる場合があります。
  その際は `index.js` 内の `TODO` コメント箇所を確認・修正してください。
- 大量の画像 × モデルの組み合わせを実行すると時間がかかります。
  回答待ちのタイムアウトは 1 回あたり最大 3 分に設定されています。
- ヘッドレスモードは無効にしてあるため、実行中はブラウザ画面が表示されます。

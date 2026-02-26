// ============================================================
// Genspark Model Comparator
// 複数のAIモデルに画像+プロンプトを送信し回答を比較するツール
// ============================================================

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

// --- 定数 ---
const GENSPARK_URL = "https://www.genspark.ai";
const GENSPARK_LOGIN_URL = "https://www.genspark.ai/login";
const GENSPARK_CHAT_URL = "https://www.genspark.ai/agents?type=ai_chat";
const TIMEOUT_NAV = 30000;
const TIMEOUT_NAV_LOGIN = 180000; // 手動ログイン後のページ遷移待ち最大3分
const TIMEOUT_RESPONSE = 180000; // 回答待ち最大3分
const DELAY_BETWEEN_ACTIONS = 1500; // 操作間の待ち時間(ms)

// --- ユーティリティ ---

function timestamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}_${hh}${mi}${ss}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** CSV用にフィールドをエスケープ */
function escapeCsv(value) {
  const str = String(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (str.includes('"') || str.includes(",") || str.includes("\n")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function log(msg) {
  const ts = new Date().toLocaleTimeString("ja-JP");
  console.log(`[${ts}] ${msg}`);
}

/**
 * コンソールでユーザーの Enter 入力を待つ
 * ブラウザは開いたまま、手動操作を促してから再開できる
 */
function waitForEnter(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

// --- 設定ファイル読み込み ---

/**
 * genspark.txt から認証情報を読み込む
 * 形式: id=xxx / pass=xxx の2行
 */
function loadCredentials() {
  const p = path.resolve(__dirname, "genspark.txt");
  if (!fs.existsSync(p)) {
    throw new Error(
      "genspark.txt が見つかりません。genspark.txt を作成し id= と pass= を記入してください"
    );
  }
  const lines = fs.readFileSync(p, "utf-8").split("\n");
  let id = "";
  let pass = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("id=")) {
      id = trimmed.substring(3).trim();
    } else if (trimmed.startsWith("pass=")) {
      pass = trimmed.substring(5).trim();
    }
  }
  if (!id || !pass) {
    throw new Error(
      "genspark.txt に id または pass が設定されていません"
    );
  }
  return { id, pass };
}

function loadPrompt() {
  const p = path.resolve(__dirname, "prompt.txt");
  if (!fs.existsSync(p)) {
    throw new Error("prompt.txt が見つかりません");
  }
  return fs.readFileSync(p, "utf-8").trim();
}

function loadModels() {
  const p = path.resolve(__dirname, "models.txt");
  if (!fs.existsSync(p)) {
    throw new Error("models.txt が見つかりません");
  }
  return fs
    .readFileSync(p, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function loadImages() {
  const dir = path.resolve(__dirname, "images");
  if (!fs.existsSync(dir)) {
    throw new Error("images/ ディレクトリが見つかりません");
  }
  const exts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];
  const files = fs.readdirSync(dir).filter((f) => {
    return exts.includes(path.extname(f).toLowerCase());
  });
  if (files.length === 0) {
    throw new Error("images/ ディレクトリに画像ファイルがありません");
  }
  return files.map((f) => ({
    name: f,
    path: path.join(dir, f),
  }));
}

// --- CSV書き込み ---

class CsvWriter {
  constructor(filePath) {
    this.filePath = filePath;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // BOM + ヘッダー行
    fs.writeFileSync(
      filePath,
      "\uFEFF" + "画像ファイル名,使用モデル,応答時間,レスポンス\n",
      "utf-8"
    );
  }

  append(imageName, model, elapsed, response) {
    const line = [
      escapeCsv(imageName),
      escapeCsv(model),
      escapeCsv(elapsed),
      escapeCsv(response),
    ].join(",");
    fs.appendFileSync(this.filePath, line + "\n", "utf-8");
  }
}

// --- Genspark 操作 ---

/**
 * ログイン済み（課金済み）か判定する
 * - ログインページにリダイレクトされたら未ログイン
 * - .upgrade-prompt が表示されていたら未ログイン（or 無料アカウント）
 */
async function checkLogin(page, navTimeout = TIMEOUT_NAV) {
  log("ログイン状態を確認中...");
  await page.goto(GENSPARK_CHAT_URL, {
    waitUntil: "domcontentloaded",
    timeout: navTimeout,
  });
  await sleep(5000);

  const currentUrl = page.url();
  // ログインページにリダイレクトされた場合
  if (
    currentUrl.includes("/login") ||
    currentUrl.includes("/signin") ||
    currentUrl.includes("/auth")
  ) {
    log("  → ログインページにリダイレクトされました");
    return false;
  }

  // 「プラスにアップグレード」が表示されていたら未ログイン扱い
  const upgradePrompt = await page.$(".upgrade-prompt");
  if (upgradePrompt) {
    const isVisible = await upgradePrompt.isVisible();
    if (isVisible) {
      log("  → upgrade-prompt が検出されました（未ログインまたは無料アカウント）");
      return false;
    }
  }

  return true;
}

/**
 * 自動ログインを実行する
 * 1. ログインページに遷移
 * 2. "Login with email" ボタンをクリック
 * 3. email / password を入力して送信
 * 4. チャットページにリダイレクトされるまで待機
 */
async function performLogin(page, credentials) {
  log("自動ログインを開始...");

  // 1. ログインページに遷移
  await page.goto(GENSPARK_LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT_NAV,
  });
  await sleep(3000);

  // 2. "Login with email" ボタンをクリック
  // TODO: ボタンのセレクタが異なる場合はここを修正してください
  const emailLoginBtn = page.locator('button:has-text("Login with email"), button:has-text("login with email"), button:has-text("Email")');
  try {
    await emailLoginBtn.first().waitFor({ state: "visible", timeout: 10000 });
    await emailLoginBtn.first().click();
    log("  'Login with email' ボタンをクリックしました");
    await sleep(DELAY_BETWEEN_ACTIONS);
  } catch {
    log("  [警告] 'Login with email' ボタンが見つかりません。入力欄が既に表示されている可能性があります。");
  }

  // 3. email を入力
  const emailInput = await page.waitForSelector("#email", {
    state: "visible",
    timeout: 10000,
  });
  await emailInput.click();
  await sleep(300);
  await emailInput.fill(credentials.id);
  log("  メールアドレスを入力しました");
  await sleep(500);

  // 4. password を入力
  const passInput = await page.waitForSelector("#password", {
    state: "visible",
    timeout: 10000,
  });
  await passInput.click();
  await sleep(300);
  await passInput.fill(credentials.pass);
  log("  パスワードを入力しました");
  await sleep(500);

  // 5. ログインボタンをクリック (フォーム内の submit ボタン)
  // TODO: ログインボタンのセレクタが異なる場合はここを修正してください
  const submitBtn = page.locator(
    'button[type="submit"], button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in")'
  );
  try {
    await submitBtn.first().waitFor({ state: "visible", timeout: 5000 });
    await submitBtn.first().click();
    log("  ログインボタンをクリックしました");
  } catch {
    // submit ボタンが見つからなければ Enter で送信
    log("  ログインボタンが見つかりません。Enter キーで送信します。");
    await page.keyboard.press("Enter");
  }

  // 6. ログイン完了を待機 (ログインページから離れるまで)
  log("  ログイン処理を待機中...");
  try {
    await page.waitForURL(
      (url) => !url.toString().includes("/login") && !url.toString().includes("/signin"),
      { timeout: TIMEOUT_NAV_LOGIN }
    );
    log("  ログインに成功しました");
  } catch {
    log("  [警告] ログイン後のリダイレクトを検出できませんでした");
  }
  await sleep(3000);
}

/**
 * 新しいチャットページに移動する
 */
async function navigateToNewChat(page) {
  log("新しいチャットを開始...");
  await page.goto(GENSPARK_CHAT_URL, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT_NAV,
  });
  await sleep(3000);
}

/**
 * モデルを選択する
 * @returns {boolean} 選択成功かどうか
 */
async function selectModel(page, modelName) {
  log(`モデル選択: ${modelName}`);

  // 1. モデル選択ボタンをクリック
  const modelBtn = await page.$(".model-selection-button");
  if (!modelBtn) {
    log("  [エラー] model-selection-button が見つかりません");
    return false;
  }
  await modelBtn.click();
  await sleep(DELAY_BETWEEN_ACTIONS);

  // 2. ドロップダウン内からモデル名を探してクリック
  //    テキスト完全一致で探す
  // TODO: ドロップダウン内のモデル名要素のセレクタが異なる場合はここを修正してください
  //       現在はドロップダウン内の全テキスト要素からmodelNameと完全一致するものを探しています
  const modelItem = await page.locator(`text="${modelName}"`).first();
  try {
    await modelItem.waitFor({ state: "visible", timeout: 5000 });
    await modelItem.click();
    log(`  モデル "${modelName}" を選択しました`);
    await sleep(DELAY_BETWEEN_ACTIONS);

    // ドロップダウンが残っていたら閉じる
    const dropdown = await page.$(".model-dropdown");
    if (dropdown && (await dropdown.isVisible())) {
      log("  ドロップダウンが残っています。閉じます...");
      await page.keyboard.press("Escape");
      await sleep(1000);
      // それでも残っていたら画面の別の場所をクリック
      const still = await page.$(".model-dropdown");
      if (still && (await still.isVisible())) {
        await page.mouse.click(0, 0);
        await sleep(1000);
      }
    }
    return true;
  } catch {
    log(`  [エラー] モデル "${modelName}" がドロップダウン内に見つかりません。スキップします。`);
    // ドロップダウンを閉じるためにEscキーを押す
    await page.keyboard.press("Escape");
    await sleep(500);
    return false;
  }
}

/**
 * +ボタン → ローカルファイル参照 の一連の操作を試みる
 * @returns {boolean} fileChooser でファイル設定まで成功したか
 */
async function tryUploadImage(page, imagePath) {
  // 1. +ボタンをクリック
  const addBtn = await page.$(".add-entry-btn");
  if (!addBtn) {
    log("  [エラー] add-entry-btn (+ボタン) が見つかりません");
    return false;
  }
  await addBtn.click();
  await sleep(DELAY_BETWEEN_ACTIONS);

  // 2. add-entry-option-item を探す
  const optionItems = await page.$$(".add-entry-option-item");
  if (optionItems.length === 0) {
    log("  [エラー] add-entry-option-item が見つかりません");
    return false;
  }

  // 3. 「ローカルファイルを参照」オプションを特定
  // TODO: add-entry-option-item が複数ある場合、テキストで絞り込んでいます。
  //       正しいものが選ばれない場合は、テキストやインデックスを変更してください。
  let targetOption = null;
  for (const item of optionItems) {
    const text = await item.textContent();
    if (
      text.includes("ローカル") ||
      text.includes("ファイル") ||
      text.toLowerCase().includes("local") ||
      text.toLowerCase().includes("file") ||
      text.toLowerCase().includes("upload")
    ) {
      targetOption = item;
      break;
    }
  }
  if (!targetOption) {
    log(
      "  [警告] テキストからローカルファイル参照ボタンを特定できませんでした。最初のオプションを使用します。"
    );
    targetOption = optionItems[0];
  }

  // 4. fileChooser イベントを待ちつつオプションをクリック
  //    Promise を先に作り .catch で未ハンドル reject を防ぐ
  let fileChooserCaptured = null;
  let fileChooserError = null;
  const fileChooserPromise = page
    .waitForEvent("filechooser", { timeout: 15000 })
    .then((fc) => { fileChooserCaptured = fc; })
    .catch((err) => { fileChooserError = err; });

  await targetOption.click();
  await fileChooserPromise; // resolve でも reject でもここで完了を待つ

  if (fileChooserError || !fileChooserCaptured) {
    log("  [エラー] ファイル選択ダイアログが開きませんでした");
    return false;
  }

  try {
    await fileChooserCaptured.setFiles(imagePath);
    log("  画像ファイルを選択しました");
    await sleep(DELAY_BETWEEN_ACTIONS);
    return true;
  } catch {
    log("  [エラー] ファイルの設定に失敗しました");
    return false;
  }
}

/**
 * 画像をアップロードする
 * 失敗時は手動操作を待って最大3回リトライする
 */
async function uploadImage(page, imagePath) {
  log(`画像アップロード: ${path.basename(imagePath)}`);

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const success = await tryUploadImage(page, imagePath);
    if (success) return;

    // 最終試行で失敗したら例外
    if (attempt >= MAX_RETRIES) {
      throw new Error(
        `画像アップロードに ${MAX_RETRIES} 回失敗しました。スキップします。`
      );
    }

    log("  [警告] 画像アップロードに失敗しました。手動操作を待機します。");
    log("  ブラウザ上でログイン状態や画面の状態を確認してください。");
    await waitForEnter(
      `\n>>> 問題を解消したら Enter を押してください (リトライ ${attempt}/${MAX_RETRIES})... `
    );

    // リトライ前にチャットページを開き直す
    await navigateToNewChat(page);
    await sleep(DELAY_BETWEEN_ACTIONS);
  }
}

/**
 * プロンプトを入力して送信する
 */
async function sendPrompt(page, promptText) {
  log("プロンプトを入力して送信...");

  // TODO: テキスト入力欄のセレクタが異なる場合はここを修正してください
  //       現在は textarea, [contenteditable], input[type="text"] の順で探しています
  let inputArea = await page.$('textarea, [contenteditable="true"], input[type="text"]');
  if (!inputArea) {
    // もう少し広く探す
    inputArea = await page.$('[role="textbox"]');
  }
  if (!inputArea) {
    throw new Error("テキスト入力欄が見つかりません");
  }

  await inputArea.click();
  await sleep(300);
  await inputArea.fill(promptText);
  await sleep(500);

  // Enterキーで送信
  await page.keyboard.press("Enter");
  log("  送信しました");
}

/**
 * 回答が完了するまで待機し、テキストを取得する
 * 送信ボタンが停止ボタンに切り替わり、再び送信ボタンに戻ったら完了と判定
 */
async function waitForResponseAndExtract(page) {
  log("回答を待機中...");

  // --- 停止ボタンの検出 → 消滅で回答完了を判定 ---
  // TODO: 停止ボタンのセレクタが不明なため、以下のパターンで検出を試みます。
  //       動作しない場合は、実際の停止ボタンの要素を確認し、セレクタを修正してください。
  //       候補: '.stop-button', '[aria-label="Stop"]', 'button[title="Stop"]',
  //             '.stop-generating', 'button:has-text("Stop")', 'button:has-text("停止")'
  const stopButtonSelectors = [
    'button.stop-button',
    'button[aria-label="Stop"]',
    'button[aria-label="stop"]',
    'button:has-text("Stop")',
    'button:has-text("停止")',
    '.stop-generating',
    '[class*="stop"]',
  ];

  // まず停止ボタンが表示されるのを待つ（=生成開始）
  let stopButtonFound = false;
  let stopSelector = null;

  for (let i = 0; i < 20; i++) {
    for (const sel of stopButtonSelectors) {
      try {
        const el = await page.$(sel);
        if (el && (await el.isVisible())) {
          stopButtonFound = true;
          stopSelector = sel;
          break;
        }
      } catch {
        // ignore
      }
    }
    if (stopButtonFound) break;
    await sleep(500);
  }

  if (stopButtonFound) {
    log(`  停止ボタンを検出 (${stopSelector})。回答生成中...`);
    // 停止ボタンが消えるまで待つ（=生成完了）
    try {
      await page.waitForSelector(stopSelector, {
        state: "hidden",
        timeout: TIMEOUT_RESPONSE,
      });
      log("  回答生成が完了しました");
    } catch {
      log("  [警告] 停止ボタンの消滅待ちがタイムアウトしました。現時点の回答を取得します。");
    }
  } else {
    // TODO: 停止ボタンが見つからない場合のフォールバック
    //       ここでは一定時間待機してから回答を取得します。
    //       実際の停止ボタンのセレクタを特定して上のstopButtonSelectorsに追加してください。
    log(
      "  [警告] 停止ボタンが見つかりませんでした。フォールバック: 一定時間待機します。"
    );
    log(
      "  TODO: 停止ボタンのセレクタを確認し、stopButtonSelectors に追加してください。"
    );

    // フォールバック: assistant要素が表示されるまで待ち、
    // その後テキストが変化しなくなるまで待つ
    await sleep(5000);
    let prevText = "";
    let stableCount = 0;
    for (let i = 0; i < 60; i++) {
      // 最大60回 x 3秒 = 3分
      const el = await page.$(".assistant.plain-text");
      const currentText = el ? await el.textContent() : "";
      if (currentText.length > 0 && currentText === prevText) {
        stableCount++;
        if (stableCount >= 3) {
          log("  テキストが安定しました。回答完了と判定します。");
          break;
        }
      } else {
        stableCount = 0;
      }
      prevText = currentText;
      await sleep(3000);
    }
  }

  await sleep(2000); // 完全なレンダリング待ち

  // 回答テキストを取得
  // 複数のassistant要素がある場合、最後のものを取得
  const assistantElements = await page.$$(".assistant.plain-text");
  if (assistantElements.length === 0) {
    log("  [エラー] 回答テキストの要素が見つかりませんでした");
    return "[エラー] 回答テキストの取得に失敗しました";
  }

  const lastAssistant = assistantElements[assistantElements.length - 1];
  const responseText = await lastAssistant.textContent();
  const trimmed = responseText.trim();
  log(`  回答取得完了 (${trimmed.length}文字)`);
  return trimmed;
}

// --- メイン処理 ---

async function main() {
  console.log("=== Genspark Model Comparator ===\n");

  // 設定読み込み
  const prompt = loadPrompt();
  const models = loadModels();
  const images = loadImages();

  log(`プロンプト: ${prompt.substring(0, 50)}${prompt.length > 50 ? "..." : ""}`);
  log(`モデル数: ${models.length} (${models.join(", ")})`);
  log(`画像数: ${images.length} (${images.map((i) => i.name).join(", ")})`);
  log(`合計実行回数: ${models.length * images.length}\n`);

  // CSV準備
  const csvPath = path.resolve(__dirname, "dest", `${timestamp()}.csv`);
  const csv = new CsvWriter(csvPath);
  log(`出力先: ${csvPath}\n`);

  // ブラウザ起動 (ヘッドレスモード無効)
  log("ブラウザを起動中...");
  const browser = await chromium.launch({
    headless: false,
    // Windowsのデフォルトのchromium を使用
    // 外部のChromeを使う場合は以下のようにchannelを指定:
    // channel: 'chrome',
  });

  const context = await browser.newContext({
    // ブラウザの状態を保持するためstorageStateを指定可能
    // 事前にログイン済みのstateを保存している場合:
    // storageState: path.resolve(__dirname, 'auth.json'),
  });
  const page = await context.newPage();

  // 認証情報読み込み
  const credentials = loadCredentials();
  log(`認証情報を読み込みました (id: ${credentials.id})\n`);

  // ログインチェック → 未ログインなら自動ログイン → それでもダメなら手動待機
  let isLoggedIn = await checkLogin(page);
  if (!isLoggedIn) {
    log("未ログイン状態です。自動ログインを試みます...");
    await performLogin(page, credentials);

    // 自動ログイン後に再チェック
    isLoggedIn = await checkLogin(page, TIMEOUT_NAV_LOGIN);
    if (!isLoggedIn) {
      // 自動ログイン失敗時は手動フォールバック
      log("[警告] 自動ログインに失敗しました。");
      log("開いたブラウザ上で手動ログインしてください。");
      await waitForEnter("\n>>> ログインが完了したら Enter を押してください... ");

      isLoggedIn = await checkLogin(page, TIMEOUT_NAV_LOGIN);
      if (!isLoggedIn) {
        log("[致命的エラー] ログインが確認できませんでした。実行を中止します。");
        await browser.close();
        process.exit(1);
      }
    }
  }
  log("ログイン確認OK\n");

  // 各画像 x 各モデル で実行
  let successCount = 0;
  let skipCount = 0;
  const totalCount = images.length * models.length;
  let currentNum = 0;

  for (const image of images) {
    for (const model of models) {
      currentNum++;
      const progress = `[${currentNum}/${totalCount}]`;
      log(`\n${"=".repeat(50)}`);
      log(`${progress} 画像: ${image.name} / モデル: ${model}`);
      log("=".repeat(50));

      try {
        // 1. 新しいチャットに移動
        await navigateToNewChat(page);

        // 2. モデルを選択
        const modelSelected = await selectModel(page, model);
        if (!modelSelected) {
          const errMsg = `[スキップ] モデル "${model}" が見つかりませんでした`;
          log(errMsg);
          csv.append(image.name, model, "-", errMsg);
          skipCount++;
          continue;
        }

        // 3. 画像をアップロード
        await uploadImage(page, image.path);

        // 4. プロンプトを入力して送信
        const startTime = Date.now();
        await sendPrompt(page, prompt);

        // 5. 回答を待機して取得
        const response = await waitForResponseAndExtract(page);
        const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
        log(`  応答時間: ${elapsedSec}秒`);

        // 6. CSVに書き込み
        csv.append(image.name, model, `${elapsedSec}秒`, response);
        successCount++;
        log(`${progress} 完了!`);
      } catch (err) {
        const errMsg = `[エラー] ${err.message}`;
        log(`${progress} ${errMsg}`);
        csv.append(image.name, model, "-", errMsg);
        skipCount++;
      }
    }
  }

  // 完了
  log(`\n${"=".repeat(50)}`);
  log("全処理完了!");
  log(`  成功: ${successCount} / ${totalCount}`);
  log(`  スキップ/エラー: ${skipCount} / ${totalCount}`);
  log(`  出力ファイル: ${csvPath}`);
  log("=".repeat(50));

  await browser.close();
}

// --- 実行 ---
main().catch((err) => {
  console.error("[致命的エラー]", err);
  process.exit(1);
});

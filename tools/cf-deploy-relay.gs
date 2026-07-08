/**
 * Cloudflare Pages のデプロイ完了通知を GitHub の repository_dispatch に中継する GAS。
 *
 * 経路: Cloudflare Notifications(Pages デプロイ成功) → [この GAS Web App] →
 *       GitHub repository_dispatch → .github/workflows/post-deploy-smoke.yml → スモーク
 *
 * なぜ中継が要るか: GitHub の起動口(repository_dispatch)は Authorization ヘッダと
 * 決まった形の body を要求するが、Cloudflare の通知 Webhook は payload/ヘッダが固定で
 * それを組み立てられない。GAS がその整形と署名(トークン付与)を担う。
 *
 * ── セットアップ ─────────────────────────────────────────────
 * 1. この関数を含むプロジェクトを Web アプリとしてデプロイ:
 *      デプロイ → 新しいデプロイ → 種類=ウェブアプリ
 *      実行ユーザー=自分 / アクセスできるユーザー=**全員**(Cloudflare が匿名で叩くため)
 * 2. スクリプトプロパティ(プロジェクトの設定 → スクリプト プロパティ)に登録:
 *      GH_TOKEN     … GitHub Fine-grained PAT(このリポジトリのみ / Contents: Read and write)
 *      GH_OWNER     … min-nano
 *      GH_REPO      … inhouse-portal
 *      RELAY_SECRET … 任意のランダム長文字列(下記 ?key= と一致させる)
 * 3. Cloudflare ダッシュボード → Notifications で「Pages デプロイ成功」通知を作成し、
 *      Webhook 宛先の URL を **クエリ文字列にシークレットを付けて**設定する:
 *        https://script.google.com/macros/s/XXXXX/exec?key=<RELAY_SECRET>
 *      (GAS の doPost はリクエストヘッダを読めないため、Cloudflare の
 *       cf-webhook-auth ヘッダではなく、この ?key= で認証する)
 * ────────────────────────────────────────────────────────────
 */

var EVENT_TYPE = "cloudflare-pages-deploy";

function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty("RELAY_SECRET");
  var given = e && e.parameter ? e.parameter.key : "";

  // クエリ文字列の共有シークレットで認証(不一致は無視して 200 を返すだけ)。
  if (!secret || given !== secret) {
    return ContentService.createTextOutput("forbidden");
  }

  // Cloudflare の通知 payload(スキーマは環境依存)。そのまま client_payload に載せて
  // 転送し、環境/コミットは best-effort で抽出する。判別できなければ本番扱い。
  var cf = {};
  try {
    if (e.postData && e.postData.contents) cf = JSON.parse(e.postData.contents);
  } catch (err) {
    cf = { parseError: String(err), raw: e.postData ? e.postData.contents : "" };
  }

  var text = JSON.stringify(cf).toLowerCase();
  var mode = text.indexOf("preview") !== -1 ? "preview" : "production";

  var owner = props.getProperty("GH_OWNER");
  var repo = props.getProperty("GH_REPO");
  var token = props.getProperty("GH_TOKEN");
  if (!owner || !repo || !token) {
    return ContentService.createTextOutput("relay not configured");
  }

  var res = UrlFetchApp.fetch(
    "https://api.github.com/repos/" + owner + "/" + repo + "/dispatches",
    {
      method: "post",
      contentType: "application/json",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      payload: JSON.stringify({
        event_type: EVENT_TYPE,
        // 検査モードと(あれば)Cloudflare の生 payload を workflow に渡す。
        client_payload: { mode: mode, cloudflare: cf },
      }),
      muteHttpExceptions: true,
    },
  );

  // GitHub の dispatch 成功は 204。ログに残して Cloudflare には 200 を返す。
  console.log("github dispatch status: " + res.getResponseCode());
  return ContentService.createTextOutput("ok");
}

/** 動作確認用: RELAY_SECRET を使って自分自身の doPost 相当を叩けないので、
 *  代わりに GitHub への疎通だけ確認する簡易テスト(手動実行)。 */
function testDispatch() {
  var props = PropertiesService.getScriptProperties();
  var res = UrlFetchApp.fetch(
    "https://api.github.com/repos/" +
      props.getProperty("GH_OWNER") +
      "/" +
      props.getProperty("GH_REPO") +
      "/dispatches",
    {
      method: "post",
      contentType: "application/json",
      headers: {
        Authorization: "Bearer " + props.getProperty("GH_TOKEN"),
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      payload: JSON.stringify({
        event_type: EVENT_TYPE,
        client_payload: { mode: "production", cloudflare: { test: true } },
      }),
      muteHttpExceptions: true,
    },
  );
  console.log("status " + res.getResponseCode() + ": " + res.getContentText());
}

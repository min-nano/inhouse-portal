/**
 * GASレジストリ Webアプリ (Phase 2)
 *
 * 自分が所有するGASプロジェクトのうち、Webアプリとしてデプロイ済みのものを
 * Drive API + Apps Script API で列挙し、JSONで返す。ポータル(Cloudflare
 * Functions)の /api/registry からプロキシ経由で呼ばれる。
 *
 * デプロイ設定:
 *   - 実行するユーザー: 自分
 *   - アクセスできるユーザー: 全員(匿名可)
 *   その上で、下の SHARED_SECRET をスクリプトプロパティに設定しておくと、
 *   ?token=... が一致するリクエストだけに応答する(匿名公開の緩衝材)。
 *
 * 事前準備:
 *   - appsscript.json のスコープを付与(このフォルダの appsscript.json 参照)
 *   - https://script.google.com/home/usersettings で Apps Script API を有効化
 *   - 応答URLを Pages の PROXY_TARGETS["registry"] に登録
 *       例: {"registry":"https://script.google.com/macros/s/XXXX/exec"}
 */

function doGet(e) {
  var provided = (e && e.parameter && e.parameter.token) || "";
  var expected = PropertiesService.getScriptProperties().getProperty(
    "SHARED_SECRET"
  );
  if (expected && provided !== expected) {
    return jsonOutput({ error: "unauthorized" });
  }

  try {
    var apps = listDeployedWebApps();
    return jsonOutput({ apps: apps });
  } catch (err) {
    return jsonOutput({ error: String(err) });
  }
}

/**
 * ドライブ内の自分のGASプロジェクトを走査し、Webアプリデプロイを持つものを返す。
 * 返り値: [{ scriptId, name, url, updateTime }]
 */
function listDeployedWebApps() {
  var token = ScriptApp.getOAuthToken();
  var headers = { Authorization: "Bearer " + token };

  // 1. ドライブ内のGASプロジェクトを検索(ページング対応)
  var files = [];
  var pageToken = "";
  do {
    var q = encodeURIComponent(
      "mimeType='application/vnd.google-apps.script' and trashed=false"
    );
    var listUrl =
      "https://www.googleapis.com/drive/v3/files?q=" +
      q +
      "&fields=nextPageToken,files(id,name,modifiedTime)&pageSize=100" +
      (pageToken ? "&pageToken=" + pageToken : "");
    var page = JSON.parse(
      UrlFetchApp.fetch(listUrl, {
        headers: headers,
        muteHttpExceptions: true,
      }).getContentText()
    );
    files = files.concat(page.files || []);
    pageToken = page.nextPageToken || "";
  } while (pageToken);

  // 2. 各プロジェクトのデプロイからWebアプリURLを取得
  var apps = [];
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var res = UrlFetchApp.fetch(
      "https://script.googleapis.com/v1/projects/" + file.id + "/deployments",
      { headers: headers, muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) continue;
    var deployments = JSON.parse(res.getContentText()).deployments || [];

    // 更新時刻の新しい順に見て、最初に見つかったWebアプリデプロイを採用
    deployments.sort(function (a, b) {
      return String(b.updateTime || "").localeCompare(String(a.updateTime || ""));
    });
    for (var j = 0; j < deployments.length; j++) {
      var d = deployments[j];
      var web = (d.entryPoints || []).filter(function (ep) {
        return ep.entryPointType === "WEB_APP";
      })[0];
      if (web && web.webApp && web.webApp.url) {
        apps.push({
          scriptId: file.id,
          name: file.name,
          url: web.webApp.url,
          updateTime: d.updateTime || file.modifiedTime || null,
        });
        break; // 1プロジェクトにつき最新の1デプロイのみ
      }
    }
  }

  // 名前順で安定させて返す
  apps.sort(function (a, b) {
    return String(a.name).localeCompare(String(b.name), "ja");
  });
  return apps;
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

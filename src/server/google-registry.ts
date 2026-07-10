/**
 * 本人(アクセスしているユーザー)の権限で、デプロイ済みGAS Webアプリを列挙する。
 *
 * ユーザー自身の OAuth アクセストークンで Drive API + Apps Script API を直接叩くため、
 * **そのユーザーがアクセスできる GAS だけ**が返る(方式B)。GASレジストリ(共有役)を
 * 立てる必要はなく、per-user のアクセス制御は Google 側の権限に委ねられる。
 *
 * 返り値は gas-registry.ts の GasApp と同形なので、既存の mergeAutoApps でそのまま
 * apps.json とマージできる。
 */
import type { GasApp } from "./gas-registry";

const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const SCRIPT_API = "https://script.googleapis.com/v1/projects";

/** アクセストークンが無効・失効しているときに投げる(呼び出し側が連携解除する)。 */
export class TokenInvalidError extends Error {
  constructor(message = "access token invalid") {
    super(message);
    this.name = "TokenInvalidError";
  }
}

type DriveFile = { id: string; name: string; modifiedTime?: string };

/** ドライブ内の自分がアクセスできる GAS プロジェクトを列挙する(ページング対応)。 */
export async function listUserScripts(accessToken: string): Promise<DriveFile[]> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const files: DriveFile[] = [];
  let pageToken = "";
  do {
    const url = new URL(DRIVE_FILES);
    url.searchParams.set(
      "q",
      "mimeType='application/vnd.google-apps.script' and trashed=false",
    );
    url.searchParams.set("fields", "nextPageToken,files(id,name,modifiedTime)");
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("orderBy", "modifiedTime desc");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), { headers });
    if (res.status === 401) throw new TokenInvalidError();
    if (!res.ok) {
      throw new Error(`Drive API error: HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      files?: DriveFile[];
      nextPageToken?: string;
    };
    for (const f of data.files ?? []) {
      if (f && typeof f.id === "string" && typeof f.name === "string") {
        files.push(f);
      }
    }
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
  return files;
}

type Deployment = {
  updateTime?: string;
  entryPoints?: { entryPointType?: string; webApp?: { url?: string } }[];
};

/**
 * 1プロジェクトの最新 WebアプリデプロイURLを返す。無ければ null。
 * Apps Script API 未有効化などの権限エラーは AppsScriptDisabled として扱う。
 */
export async function listWebAppUrl(
  accessToken: string,
  scriptId: string,
): Promise<{ url: string; updateTime?: string } | null> {
  const res = await fetch(`${SCRIPT_API}/${scriptId}/deployments`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) throw new TokenInvalidError();
  if (res.status === 403) {
    // Apps Script API 未有効化 or 権限不足。呼び出し側でヒントを出せるよう通知。
    throw new AppsScriptForbiddenError();
  }
  if (!res.ok) return null;

  const data = (await res.json()) as { deployments?: Deployment[] };
  const deployments = [...(data.deployments ?? [])].sort((a, b) =>
    String(b.updateTime ?? "").localeCompare(String(a.updateTime ?? "")),
  );
  for (const d of deployments) {
    const web = (d.entryPoints ?? []).find(
      (e) => e.entryPointType === "WEB_APP",
    );
    if (web?.webApp?.url) {
      return { url: web.webApp.url, updateTime: d.updateTime };
    }
  }
  return null;
}

/** Apps Script API が有効化されていない/権限不足のときに投げる。 */
export class AppsScriptForbiddenError extends Error {
  constructor(message = "Apps Script API forbidden") {
    super(message);
    this.name = "AppsScriptForbiddenError";
  }
}

/**
 * 本人権限で GASプロジェクトを列挙し、Webアプリとしてデプロイ済みのものを
 * GasApp[] で返す。
 *
 * - TokenInvalidError: トークンが失効(呼び出し側で連携解除)
 * - すべてのデプロイ照会が Apps Script API 403 なら AppsScriptForbiddenError
 *   (Apps Script API 未有効化のヒントを出すため)。一部だけ 403 の場合は無視して継続。
 */
export async function fetchUserRegistry(accessToken: string): Promise<GasApp[]> {
  const scripts = await listUserScripts(accessToken);
  const apps: GasApp[] = [];
  let forbidden = 0;
  let attempted = 0;

  for (const file of scripts) {
    attempted++;
    let web: { url: string; updateTime?: string } | null;
    try {
      web = await listWebAppUrl(accessToken, file.id);
    } catch (err) {
      if (err instanceof TokenInvalidError) throw err;
      if (err instanceof AppsScriptForbiddenError) {
        forbidden++;
        continue;
      }
      continue; // 個別プロジェクトの一時エラーはスキップ
    }
    if (!web) continue;
    apps.push({
      scriptId: file.id,
      name: file.name,
      url: web.url,
      updateTime: web.updateTime ?? file.modifiedTime,
    });
  }

  // 対象があったのに全て 403 = Apps Script API 未有効化とみなしてヒントを出す
  if (attempted > 0 && forbidden === attempted && apps.length === 0) {
    throw new AppsScriptForbiddenError();
  }
  return apps;
}

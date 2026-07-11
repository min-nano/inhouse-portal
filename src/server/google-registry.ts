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

/** listUserScripts の結果。incompleteSearch は Drive が全コーパスを検索しきれなかった印。 */
export type UserScripts = { files: DriveFile[]; incompleteSearch: boolean };

/** ドライブ内の自分がアクセスできる GAS プロジェクトを列挙する(ページング対応)。 */
export async function listUserScripts(
  accessToken: string,
  limit = MAX_PROJECTS,
): Promise<UserScripts> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const files: DriveFile[] = [];
  // corpora=allDrives では Drive が全共有ドライブを検索しきれず incompleteSearch が
  // 立つことがある。その場合「欠けた一覧」を無言で返さないよう呼び出し側へ伝える。
  let incompleteSearch = false;
  // orderBy=modifiedTime desc なので必要なのは先頭 limit 件だけ。使わないページを
  // 取得してサブリクエストを浪費しないよう、limit 件そろったら打ち切る。
  const pageSize = Math.min(Math.max(limit, 1), 100);
  let pageToken = "";
  do {
    const url = new URL(DRIVE_FILES);
    url.searchParams.set(
      "q",
      "mimeType='application/vnd.google-apps.script' and trashed=false",
    );
    url.searchParams.set(
      "fields",
      "nextPageToken,incompleteSearch,files(id,name,modifiedTime)",
    );
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("orderBy", "modifiedTime desc");
    // 共有ドライブ(Shared Drives)内の GAS も対象にする。既定 (corpora=user) は
    // マイドライブしか見ないため、これらを付けないと共有ドライブ保管分は列挙されない。
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    url.searchParams.set("corpora", "allDrives");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), { headers });
    if (res.status === 401) throw new TokenInvalidError();
    if (!res.ok) {
      throw new Error(`Drive API error: HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      files?: DriveFile[];
      nextPageToken?: string;
      incompleteSearch?: boolean;
    };
    if (data.incompleteSearch) incompleteSearch = true;
    for (const f of data.files ?? []) {
      if (f && typeof f.id === "string" && typeof f.name === "string") {
        files.push(f);
      }
    }
    pageToken = data.nextPageToken ?? "";
  } while (pageToken && files.length < limit);
  if (incompleteSearch) {
    console.warn(
      "Drive files.list returned incompleteSearch=true; 共有ドライブの一部が列挙から欠落している可能性があります",
    );
  }
  return { files: files.slice(0, limit), incompleteSearch };
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
 * 1リクエストで照会するGASプロジェクト数の上限。Cloudflare 無料プランの
 * 50サブリクエスト/リクエスト制限を超えないための安全弁(Drive一覧+各デプロイ照会)。
 * Drive は modifiedTime 降順なので、超過時は「最近更新されたもの」が優先される。
 */
export const MAX_PROJECTS = 40;
/** デプロイ照会の同時実行数(レイテンシ短縮しつつ上流に優しく) */
const DEPLOYMENT_CONCURRENCY = 6;

/** 配列を同時実行数を絞って map する。 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/** fetchUserRegistry の結果。incompleteSearch は共有ドライブ検索が不完全だった印。 */
export type UserRegistry = { apps: GasApp[]; incompleteSearch: boolean };

/**
 * 本人権限で GASプロジェクトを列挙し、Webアプリとしてデプロイ済みのものを返す。
 *
 * - TokenInvalidError: トークンが失効(呼び出し側で連携解除)
 * - すべてのデプロイ照会が Apps Script API 403 なら AppsScriptForbiddenError
 *   (Apps Script API 未有効化のヒントを出すため)。一部だけ 403 の場合は無視して継続。
 */
export async function fetchUserRegistry(
  accessToken: string,
): Promise<UserRegistry> {
  // listUserScripts が最近更新の上位 MAX_PROJECTS 件までに絞って返す
  // (Drive のページングもそこで打ち切られ、サブリクエストを浪費しない)。
  const { files: scripts, incompleteSearch } =
    await listUserScripts(accessToken);

  type Outcome =
    | { kind: "app"; app: GasApp }
    | { kind: "forbidden" }
    | { kind: "skip" }
    | { kind: "invalid" };

  const outcomes = await mapWithConcurrency(
    scripts,
    DEPLOYMENT_CONCURRENCY,
    async (file): Promise<Outcome> => {
      try {
        const web = await listWebAppUrl(accessToken, file.id);
        if (!web) return { kind: "skip" };
        return {
          kind: "app",
          app: {
            scriptId: file.id,
            name: file.name,
            url: web.url,
            updateTime: web.updateTime ?? file.modifiedTime,
          },
        };
      } catch (err) {
        if (err instanceof TokenInvalidError) return { kind: "invalid" };
        if (err instanceof AppsScriptForbiddenError) return { kind: "forbidden" };
        return { kind: "skip" }; // 個別プロジェクトの一時エラーはスキップ
      }
    },
  );

  if (outcomes.some((o) => o.kind === "invalid")) throw new TokenInvalidError();

  const apps = outcomes
    .filter((o): o is { kind: "app"; app: GasApp } => o.kind === "app")
    .map((o) => o.app);
  const forbidden = outcomes.filter((o) => o.kind === "forbidden").length;

  // 対象があったのに全て 403 = Apps Script API 未有効化とみなしてヒントを出す
  if (scripts.length > 0 && forbidden === scripts.length && apps.length === 0) {
    throw new AppsScriptForbiddenError();
  }
  return { apps, incompleteSearch };
}

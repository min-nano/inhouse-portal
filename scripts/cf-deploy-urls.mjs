/**
 * Cloudflare Pages API から、そのデプロイで検査すべきURLを解決する。
 *
 * post-deploy-smoke ワークフローが解決結果を scripts/smoke.mjs へ渡す。固定値にできない
 * URL(デプロイ毎に変わる)も、手入力を避けたい固定URLも、まとめて API から取得する。
 *
 * production モード(DEPLOY_ENV=production)で解決するもの:
 *   - 本番固定ドメイン: Project API の `domains`(カスタムドメイン + pages.dev サブドメイン)
 *     と `subdomain`
 *   - そのデプロイのユニークURL / エイリアス: Deployment API の `url` / `aliases`(SHA一致)
 * preview モード(それ以外)で解決するもの:
 *   - そのデプロイのユニークURL / ブランチエイリアス: Deployment API の `url` / `aliases`(SHA一致)
 *
 * 入力(環境変数):
 *   CF_API_TOKEN     … Cloudflare API トークン(Account → Cloudflare Pages → Read)
 *   CF_ACCOUNT_ID    … アカウントID
 *   CF_PAGES_PROJECT … Pages プロジェクト名(例: inhouse-portal)
 *   COMMIT_SHA       … 対象デプロイの commit SHA(deployment.sha)
 *   DEPLOY_ENV       … "production" | "preview"
 *   CF_API_BASE      … (任意)APIベースURL上書き。テスト用
 *
 * 出力: 解決したURLを1行1件で stdout に出す(https:// 付き・重複除去)。
 * 失敗時(トークン無し/API失敗/該当なし)は stderr に警告を出し、取れた分だけ出力する
 * (何も取れなければ空)。ここでは **exit 0** を保ち、呼び出し側のフォールバック
 * (environment_url / SMOKE_BASE_URLS)に委ねる。本命のスモークを落とさないため。
 */

const API_BASE = process.env.CF_API_BASE || "https://api.cloudflare.com/client/v4";

function warn(msg) {
  process.stderr.write(`cf-deploy-urls: ${msg}\n`);
}

/** hostname でも URL でも https:// 付き・末尾スラッシュ無しに正規化 */
function toOrigin(hostOrUrl) {
  const s = String(hostOrUrl).trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//.test(s) ? s : `https://${s}`;
  return withScheme.replace(/\/+$/, "");
}

async function fetchJson(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 本番固定ドメイン(Project API の domains + subdomain) */
async function resolveProjectDomains(base, account, project, token) {
  const url = `${base}/accounts/${account}/pages/projects/${project}`;
  const body = await fetchJson(url, token);
  const r = body?.result ?? {};
  const out = [];
  if (Array.isArray(r.domains)) out.push(...r.domains);
  if (typeof r.subdomain === "string") out.push(r.subdomain);
  return out;
}

/** そのデプロイの url + aliases(SHA一致で特定) */
async function resolveDeploymentUrls(base, account, project, token, env, sha) {
  const url =
    `${base}/accounts/${account}/pages/projects/${project}` +
    `/deployments?env=${env}&per_page=25`;
  const body = await fetchJson(url, token);
  const list = Array.isArray(body?.result) ? body.result : [];
  const commitOf = (d) => d?.deployment_trigger?.metadata?.commit_hash ?? "";
  let match = list.find((d) => commitOf(d) === sha);
  if (!match) {
    match = list.find(
      (d) => commitOf(d).startsWith(sha) || sha.startsWith(commitOf(d) || "\0"),
    );
  }
  if (!match) {
    warn(`SHA ${sha} に一致するデプロイが見つからない。`);
    return [];
  }
  const out = [];
  if (typeof match.url === "string") out.push(match.url);
  if (Array.isArray(match.aliases)) out.push(...match.aliases);
  return out;
}

async function main() {
  const token = process.env.CF_API_TOKEN;
  const account = process.env.CF_ACCOUNT_ID;
  const project = process.env.CF_PAGES_PROJECT;
  const sha = process.env.COMMIT_SHA;
  const env = process.env.DEPLOY_ENV === "production" ? "production" : "preview";

  if (!token || !account || !project) {
    warn("CF_API_TOKEN / CF_ACCOUNT_ID / CF_PAGES_PROJECT が未設定。解決をスキップ。");
    return;
  }

  const collected = [];

  // 本番の固定ドメインは Project API から(preview には該当しない)。
  if (env === "production") {
    try {
      collected.push(...(await resolveProjectDomains(API_BASE, account, project, token)));
    } catch (e) {
      warn(`Project API 失敗(固定ドメインをスキップ): ${e.message}`);
    }
  }

  // そのデプロイのユニークURL / エイリアスは Deployment API から SHA で特定。
  if (sha) {
    try {
      collected.push(
        ...(await resolveDeploymentUrls(API_BASE, account, project, token, env, sha)),
      );
    } catch (e) {
      warn(`Deployment API 失敗(デプロイURLをスキップ): ${e.message}`);
    }
  } else {
    warn("COMMIT_SHA が空。デプロイURLの解決をスキップ。");
  }

  const unique = [...new Set(collected.map(toOrigin).filter(Boolean))];
  if (unique.length === 0) {
    warn("解決できたURLが無い。フォールバックに委ねる。");
    return;
  }
  process.stdout.write(unique.join("\n") + "\n");
}

main();

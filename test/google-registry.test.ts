import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppsScriptForbiddenError,
  fetchUserRegistry,
  listUserScripts,
  TokenInvalidError,
} from "../src/server/google-registry";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** URLに応じて応答を返す簡易 fetch モック */
function routeFetch(
  handlers: (url: string) => { status?: number; body: unknown } | undefined,
) {
  return vi.fn(async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const r = handlers(url);
    if (!r) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
}

const driveTwoScripts = {
  files: [
    { id: "SID1", name: "日報", modifiedTime: "2026-07-01T00:00:00Z" },
    { id: "SID2", name: "図面", modifiedTime: "2026-06-01T00:00:00Z" },
  ],
};

describe("listUserScripts", () => {
  it("401はTokenInvalidError", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch((u) => (u.includes("/drive/") ? { status: 401, body: {} } : undefined)),
    );
    await expect(listUserScripts("bad")).rejects.toBeInstanceOf(
      TokenInvalidError,
    );
  });
});

describe("fetchUserRegistry", () => {
  it("Webアプリデプロイを持つプロジェクトだけ GasApp で返す", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch((u) => {
        if (u.includes("/drive/")) return { body: driveTwoScripts };
        if (u.includes("/SID1/deployments"))
          return {
            body: {
              deployments: [
                {
                  updateTime: "2026-07-02T00:00:00Z",
                  entryPoints: [
                    {
                      entryPointType: "WEB_APP",
                      webApp: {
                        url: "https://script.google.com/macros/s/SID1/exec",
                      },
                    },
                  ],
                },
              ],
            },
          };
        // SID2 はWebアプリなし
        if (u.includes("/SID2/deployments"))
          return { body: { deployments: [{ entryPoints: [] }] } };
        return undefined;
      }),
    );
    const apps = await fetchUserRegistry("good");
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      scriptId: "SID1",
      name: "日報",
      url: "https://script.google.com/macros/s/SID1/exec",
      updateTime: "2026-07-02T00:00:00Z",
    });
  });

  it("全プロジェクトが403ならAppsScriptForbiddenError", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch((u) => {
        if (u.includes("/drive/")) return { body: driveTwoScripts };
        return { status: 403, body: { error: "disabled" } };
      }),
    );
    await expect(fetchUserRegistry("good")).rejects.toBeInstanceOf(
      AppsScriptForbiddenError,
    );
  });

  it("一部だけ403なら無視して継続する", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch((u) => {
        if (u.includes("/drive/")) return { body: driveTwoScripts };
        if (u.includes("/SID1/deployments"))
          return {
            body: {
              deployments: [
                {
                  entryPoints: [
                    {
                      entryPointType: "WEB_APP",
                      webApp: {
                        url: "https://script.google.com/macros/s/SID1/exec",
                      },
                    },
                  ],
                },
              ],
            },
          };
        return { status: 403, body: {} };
      }),
    );
    const apps = await fetchUserRegistry("good");
    expect(apps.map((a) => a.scriptId)).toEqual(["SID1"]);
  });
});

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

  it("limit に達したら次ページを取りに行かない(サブリクエスト浪費防止)", async () => {
    // 1ページ目で limit を満たし、nextPageToken があっても2回目は呼ばない
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify({
            files: [
              { id: "A", name: "a" },
              { id: "B", name: "b" },
            ],
            nextPageToken: "more",
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { files } = await listUserScripts("good", 2);
    expect(files.map((f) => f.id)).toEqual(["A", "B"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    // pageSize は limit に合わせる
    const calledUrl = new URL(fetchMock.mock.calls[0]![0]);
    expect(calledUrl.searchParams.get("pageSize")).toBe("2");
    // 共有ドライブ(Shared Drives)を対象にするパラメータが落ちていないこと。
    // これらが欠けると共有ドライブ保管分が静かに列挙から消える。
    expect(calledUrl.searchParams.get("supportsAllDrives")).toBe("true");
    expect(calledUrl.searchParams.get("includeItemsFromAllDrives")).toBe("true");
    expect(calledUrl.searchParams.get("corpora")).toBe("allDrives");
  });

  it("incompleteSearch=true を伝播する(共有ドライブ検索が不完全)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ files: [{ id: "A", name: "a" }], incompleteSearch: true }),
            { status: 200 },
          ),
      ),
    );
    const { files, incompleteSearch } = await listUserScripts("good", 5);
    expect(files.map((f) => f.id)).toEqual(["A"]);
    expect(incompleteSearch).toBe(true);
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
    const { apps } = await fetchUserRegistry("good");
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
    const { apps } = await fetchUserRegistry("good");
    expect(apps.map((a) => a.scriptId)).toEqual(["SID1"]);
  });
});

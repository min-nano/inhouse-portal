import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  normalizeIssuer,
  resetAccessJwksCache,
  verifyAccessJwt,
} from "../src/server/auth/cf-access";
import { onRequest } from "../functions/_middleware";
import type { Env } from "../src/server/app";

const TEAM = "testteam";
const ISSUER = "https://testteam.cloudflareaccess.com";
const AUD = "aud-tag-1234567890abcdef";
const KID = "test-kid";

let privateKey: CryptoKey;
let jwks: unknown;

function b64urlStr(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signRs256(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<string> {
  const h = b64urlStr(JSON.stringify(header));
  const p = b64urlStr(JSON.stringify(payload));
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return `${h}.${p}.${b64urlBytes(new Uint8Array(sig))}`;
}

/** 有効なトークンの標準クレーム */
function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    aud: AUD,
    email: "taro@example.co.jp",
    sub: "user-1",
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
}

function token(overrides: Record<string, unknown> = {}, kid = KID) {
  return signRs256({ alg: "RS256", kid }, claims(overrides));
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  privateKey = pair.privateKey;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<
    string,
    unknown
  >;
  jwks = { keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] };
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAccessJwksCache();
});

/** JWKS エンドポイントだけ応答する fetch モック */
function stubJwks() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string | URL) => {
      if (String(u).endsWith("/cdn-cgi/access/certs")) {
        return new Response(JSON.stringify(jwks), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

describe("normalizeIssuer", () => {
  it("各種表記から issuer を組み立てる", () => {
    expect(normalizeIssuer("myteam")).toBe(
      "https://myteam.cloudflareaccess.com",
    );
    expect(normalizeIssuer("myteam.cloudflareaccess.com")).toBe(
      "https://myteam.cloudflareaccess.com",
    );
    expect(normalizeIssuer("https://myteam.cloudflareaccess.com/")).toBe(
      "https://myteam.cloudflareaccess.com",
    );
  });
});

describe("verifyAccessJwt", () => {
  it("正当なトークンは身元を返す", async () => {
    stubJwks();
    const id = await verifyAccessJwt(await token(), { teamDomain: TEAM, aud: AUD });
    expect(id).toEqual({ email: "taro@example.co.jp", sub: "user-1" });
  });

  it("署名改ざんは null", async () => {
    stubJwks();
    const t = await token();
    const tampered = t.slice(0, -3) + (t.endsWith("AAA") ? "BBB" : "AAA");
    expect(
      await verifyAccessJwt(tampered, { teamDomain: TEAM, aud: AUD }),
    ).toBeNull();
  });

  it("ペイロード改ざん(署名不一致)は null", async () => {
    stubJwks();
    const t = await token();
    const [h, , s] = t.split(".");
    const forged = `${h}.${b64urlStr(
      JSON.stringify(claims({ email: "attacker@evil.com" })),
    )}.${s}`;
    expect(
      await verifyAccessJwt(forged, { teamDomain: TEAM, aud: AUD }),
    ).toBeNull();
  });

  it("iss 不一致(別チーム設定)は null", async () => {
    stubJwks();
    expect(
      await verifyAccessJwt(await token(), { teamDomain: "otherteam", aud: AUD }),
    ).toBeNull();
  });

  it("aud 不一致は null / 一致は通す", async () => {
    stubJwks();
    expect(
      await verifyAccessJwt(await token(), { teamDomain: TEAM, aud: "wrong-aud" }),
    ).toBeNull();
    expect(
      await verifyAccessJwt(await token(), { teamDomain: TEAM, aud: AUD }),
    ).not.toBeNull();
  });

  it("aud 未設定なら aud 検証をスキップする", async () => {
    stubJwks();
    expect(
      await verifyAccessJwt(await token({ aud: "anything" }), {
        teamDomain: TEAM,
      }),
    ).not.toBeNull();
  });

  it("期限切れは null", async () => {
    stubJwks();
    expect(
      await verifyAccessJwt(
        await token({ exp: Math.floor(Date.now() / 1000) - 10 }),
        { teamDomain: TEAM, aud: AUD },
      ),
    ).toBeNull();
  });

  it("未知の kid は null", async () => {
    stubJwks();
    expect(
      await verifyAccessJwt(await token({}, "unknown-kid"), {
        teamDomain: TEAM,
        aud: AUD,
      }),
    ).toBeNull();
  });

  it("RS256 以外の alg は null(検証前に弾く)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const bad = `${b64urlStr(JSON.stringify({ alg: "none", kid: KID }))}.${b64urlStr(
      JSON.stringify(claims()),
    )}.`;
    expect(
      await verifyAccessJwt(bad, { teamDomain: TEAM, aud: AUD }),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("JWKS はキャッシュされ、2回目は再取得しない", async () => {
    stubJwks();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await verifyAccessJwt(await token(), { teamDomain: TEAM, aud: AUD });
    await verifyAccessJwt(await token(), { teamDomain: TEAM, aud: AUD });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("_middleware 署名検証モード (CF_ACCESS_TEAM_DOMAIN 設定時)", () => {
  const NEXT = new Response("SERVED", { status: 200 });

  function makeContext(request: Request, env: Partial<Env> = {}) {
    const next = vi.fn(async () => NEXT);
    return { context: { request, env: env as Env, next }, next };
  }

  it("pages.dev + 正当なトークンはスルー", async () => {
    stubJwks();
    const { context, next } = makeContext(
      new Request("https://preview.inhouse-portal.pages.dev/", {
        headers: {
          accept: "text/html",
          "Cf-Access-Jwt-Assertion": await token(),
        },
      }),
      { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD },
    );
    const res = await onRequest(context);
    expect(res).toBe(NEXT);
    expect(next).toHaveBeenCalledOnce();
  });

  it("pages.dev + 偽装トークンはスルーせず OAuth へ(fail-closed)", async () => {
    stubJwks();
    const t = await token();
    const forged = t.slice(0, -3) + (t.endsWith("AAA") ? "BBB" : "AAA");
    const { context, next } = makeContext(
      new Request("https://preview.inhouse-portal.pages.dev/", {
        headers: { accept: "text/html", "Cf-Access-Jwt-Assertion": forged },
      }),
      { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, AUTH_SECRET: "s" },
    );
    const res = await onRequest(context);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).pathname).toBe(
      "/api/auth/login",
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("pages.dev + 正当なトークンでも aud 未設定ならスルーしない(両方必須)", async () => {
    stubJwks();
    const { context, next } = makeContext(
      new Request("https://preview.inhouse-portal.pages.dev/", {
        headers: {
          accept: "text/html",
          "Cf-Access-Jwt-Assertion": await token(),
        },
      }),
      { CF_ACCESS_TEAM_DOMAIN: TEAM, AUTH_SECRET: "s" }, // CF_ACCESS_AUD 未設定
    );
    const res = await onRequest(context);
    expect(res.status).toBe(302);
    expect(next).not.toHaveBeenCalled();
  });

  it("カスタムドメインは正当なトークンでもスルーしない(pages.dev限定)", async () => {
    stubJwks();
    const { context, next } = makeContext(
      new Request("https://portal.example.co.jp/api/apps", {
        headers: {
          accept: "application/json",
          "Cf-Access-Jwt-Assertion": await token(),
        },
      }),
      { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, AUTH_SECRET: "s" },
    );
    const res = await onRequest(context);
    expect(res.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

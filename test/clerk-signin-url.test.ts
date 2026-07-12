import { describe, expect, it } from "vitest";

import { buildSignInUrl } from "../src/server/auth/clerk";

// 本番形式の Publishable key(pk_live_<base64("clerk.<domain>$")>)。
// frontendApi = clerk.portal.min-nano.support を base64 で埋め込む。
const FRONTEND_API = "clerk.portal.min-nano.support";
const PUBLISHABLE_KEY = `pk_live_${btoa(`${FRONTEND_API}$`)}`;

describe("buildSignInUrl (Account Portal URL を Publishable key から導出)", () => {
  it("env 追加なしで Account Portal のサインインURL を組み立てる", () => {
    const url = buildSignInUrl(
      { CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY },
      new Request("https://portal.min-nano.support/"),
    );
    // clerk.<domain> → accounts.<domain> に変換された hosted サインイン画面。
    expect(url).toBe("https://accounts.portal.min-nano.support/sign-in");
  });

  it("Publishable key が無ければ空文字(middleware 側で 401 にフォールバック)", () => {
    const url = buildSignInUrl(
      {},
      new Request("https://portal.min-nano.support/"),
    );
    expect(url).toBe("");
  });
});

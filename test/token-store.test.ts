import { describe, expect, it } from "vitest";
import type { KVNamespace } from "../src/server/auth/allowlist";
import {
  deleteStoredToken,
  isConnected,
  loadStoredToken,
  saveRefreshToken,
} from "../src/server/auth/token-store";

const SECRET = "test-secret-please-change-0123456789";

/** テスト用の in-memory KV */
function memoryKV(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

describe("token-store", () => {
  it("保存→取得で往復する", async () => {
    const kv = memoryKV();
    await saveRefreshToken(kv, SECRET, "Taro@Example.co.jp", {
      refreshToken: "1//refresh",
      scope: "openid drive",
      connectedAt: 123,
    });
    const loaded = await loadStoredToken(kv, SECRET, "taro@example.co.jp");
    expect(loaded?.refreshToken).toBe("1//refresh");
    expect(loaded?.connectedAt).toBe(123);
  });

  it("KVには平文トークンを保存しない", async () => {
    const kv = memoryKV();
    await saveRefreshToken(kv, SECRET, "a@b.com", {
      refreshToken: "SUPER-SECRET-REFRESH",
      connectedAt: 1,
    });
    const stored = [...kv.store.values()].join("");
    expect(stored).not.toContain("SUPER-SECRET-REFRESH");
  });

  it("email はキーにハッシュ化して使う(平文emailがキーに出ない)", async () => {
    const kv = memoryKV();
    await saveRefreshToken(kv, SECRET, "a@b.com", {
      refreshToken: "x",
      connectedAt: 1,
    });
    const keys = [...kv.store.keys()].join("");
    expect(keys).not.toContain("a@b.com");
    expect(keys).toMatch(/^gtoken:[0-9a-f]{64}$/);
  });

  it("別のsecretでは復号できない(null)", async () => {
    const kv = memoryKV();
    await saveRefreshToken(kv, SECRET, "a@b.com", {
      refreshToken: "x",
      connectedAt: 1,
    });
    expect(await loadStoredToken(kv, "different-secret-value", "a@b.com")).toBeNull();
  });

  it("isConnected と delete が機能する", async () => {
    const kv = memoryKV();
    expect(await isConnected(kv, "a@b.com")).toBe(false);
    await saveRefreshToken(kv, SECRET, "a@b.com", {
      refreshToken: "x",
      connectedAt: 1,
    });
    expect(await isConnected(kv, "a@b.com")).toBe(true);
    await deleteStoredToken(kv, "a@b.com");
    expect(await isConnected(kv, "a@b.com")).toBe(false);
    expect(await loadStoredToken(kv, SECRET, "a@b.com")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  decryptString,
  encryptString,
  hmacSha256Hex,
  sha256hex,
} from "../src/server/auth/crypto";

const SECRET = "test-secret-please-change-0123456789";

describe("encryptString / decryptString", () => {
  it("往復で元の平文に戻る", async () => {
    const blob = await encryptString("1//refresh-token-value", SECRET);
    expect(blob).not.toContain("refresh-token-value");
    expect(await decryptString(blob, SECRET)).toBe("1//refresh-token-value");
  });

  it("毎回異なる暗号文になる(IVランダム)", async () => {
    const a = await encryptString("same", SECRET);
    const b = await encryptString("same", SECRET);
    expect(a).not.toBe(b);
    expect(await decryptString(a, SECRET)).toBe("same");
    expect(await decryptString(b, SECRET)).toBe("same");
  });

  it("別の鍵では復号できない(null)", async () => {
    const blob = await encryptString("secret", SECRET);
    expect(await decryptString(blob, "another-secret-value-9999")).toBeNull();
  });

  it("改ざんされた暗号文は復号できない(null)", async () => {
    const blob = await encryptString("secret", SECRET);
    const tampered = blob.slice(0, -2) + (blob.endsWith("A") ? "BB" : "AA");
    expect(await decryptString(tampered, SECRET)).toBeNull();
  });

  it("不正な形式は null", async () => {
    expect(await decryptString("", SECRET)).toBeNull();
    expect(await decryptString("!!!", SECRET)).toBeNull();
  });
});

describe("sha256hex", () => {
  it("既知値と一致する", async () => {
    expect(await sha256hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("hmacSha256Hex", () => {
  // node:crypto の createHmac と一致すること(scripts/allowlist-hash.mjs との整合を固定)。
  it("既知値(node HMACと一致)", async () => {
    expect(
      await hmacSha256Hex(
        "test-secret-please-change-0123456789",
        "allowlist:a@b.com",
      ),
    ).toBe(
      "5c2edafffe07f0c0a24e01bba2b00381bf676e48245a2e00e8f90175cc244c8b",
    );
  });

  it("鍵が違えば別の値", async () => {
    const a = await hmacSha256Hex("k1", "m");
    const b = await hmacSha256Hex("k2", "m");
    expect(a).not.toBe(b);
  });
});

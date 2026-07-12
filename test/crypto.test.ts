import { describe, expect, it } from "vitest";
import { hmacSha256Hex, sha256hex } from "../src/server/auth/crypto";

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

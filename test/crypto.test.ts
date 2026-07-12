import { describe, expect, it } from "vitest";
import { sha256hex } from "../src/server/auth/crypto";

describe("sha256hex", () => {
  it("既知値と一致する", async () => {
    expect(await sha256hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

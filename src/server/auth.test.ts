import { describe, expect, it } from "vitest";
import { hashPassword, hashToken, newBuildingCode, newSessionToken, verifyPassword } from "./auth";

describe("passwords", () => {
  it("accepts the right password and rejects a wrong one", () => {
    const stored = hashPassword("correct horse");
    expect(verifyPassword("correct horse", stored)).toBe(true);
    expect(verifyPassword("correct horsf", stored)).toBe(false);
  });

  it("never stores the password itself", () => {
    expect(hashPassword("correct horse")).not.toContain("correct horse");
  });

  it("gives two people with the same password different hashes", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("rejects a stored value it does not understand", () => {
    expect(verifyPassword("x", "")).toBe(false);
    expect(verifyPassword("x", "md5$abc$def")).toBe(false);
  });
});

describe("tokens and codes", () => {
  it("makes session tokens that do not repeat", () => {
    const tokens = new Set(Array.from({ length: 200 }, newSessionToken));
    expect(tokens.size).toBe(200);
  });

  it("hashes a token the same way every time, and not to itself", () => {
    const token = newSessionToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(token);
  });

  it("makes six-character building codes without easily confused characters", () => {
    for (let i = 0; i < 200; i++) {
      expect(newBuildingCode()).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    }
  });
});

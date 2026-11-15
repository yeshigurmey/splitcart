/**
 * Passwords and login sessions, using only Node's built-in crypto module.
 *
 * Passwords are never stored. What is stored is the output of scrypt, a
 * deliberately slow function, together with a random salt. Slow means that
 * someone who steals the database can only try a few guesses per second, and
 * the salt means two people with the same password get different hashes.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 32;

/** Returns "scrypt$<salt>$<hash>", both parts in hex. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  // A normal comparison stops at the first different byte, which leaks how
  // much of the hash matched through timing. This one always takes as long.
  return timingSafeEqual(actual, expected);
}

/** A random session token: 32 bytes is far too many possibilities to guess. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What we store instead of the token itself. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I/L to misread

/** A building invite code such as "K7QM2X". */
export function newBuildingCode(): string {
  const bytes = randomBytes(6);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

/**
 * Local, offline identity.
 *
 * The upstream game authenticates through Firebase (Google / email / Twitter),
 * which cannot work without internet. For offline and LAN play we replace it
 * with a self-contained identity: the client stores a uid + nickname in
 * localStorage and sends them as a bearer token; the server decodes the token
 * without contacting any third party.
 *
 * The token is NOT cryptographically signed. That is an accepted trade-off for
 * a local/LAN game where anyone able to reach the server is already trusted.
 * Do not expose this build to the public internet as-is.
 */
import { randomUUID } from "node:crypto"

export interface LocalUserRecord {
  uid: string
  displayName: string
  email?: string
  metadata: { language: string }
}

const TOKEN_PREFIX = "local."

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url")
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8")
}

export function createLocalToken(user: {
  uid: string
  displayName: string
  language?: string
}): string {
  const payload = {
    uid: user.uid,
    displayName: user.displayName,
    language: user.language ?? "en"
  }
  return TOKEN_PREFIX + base64UrlEncode(JSON.stringify(payload))
}

export function isLocalToken(token: string | undefined | null): boolean {
  return typeof token === "string" && token.startsWith(TOKEN_PREFIX)
}

/**
 * Decodes a local token. Returns null when the token is missing or malformed so
 * callers can decide whether to reject or fall back to a guest identity.
 */
export function decodeLocalToken(
  token: string | undefined | null
): LocalUserRecord | null {
  if (!isLocalToken(token)) return null
  try {
    const payload = JSON.parse(base64UrlDecode(token!.slice(TOKEN_PREFIX.length)))
    if (!payload?.uid) return null
    return {
      uid: String(payload.uid),
      displayName: String(payload.displayName || "Trainer"),
      metadata: { language: String(payload.language || "en") }
    }
  } catch {
    return null
  }
}

/**
 * Same contract as `admin.auth().verifyIdToken()`: throws when the token is
 * not usable. Accepts legacy Firebase-shaped tokens by treating the raw value
 * as a uid, so old localStorage entries do not lock players out.
 */
export function verifyLocalToken(
  token: string | undefined | null,
  fallback?: { uid?: string; displayName?: string }
): LocalUserRecord {
  const decoded = decodeLocalToken(token)
  if (decoded) return decoded

  if (fallback?.uid) {
    return {
      uid: fallback.uid,
      displayName: fallback.displayName || "Trainer",
      metadata: { language: "en" }
    }
  }

  // last resort: mint a guest identity instead of refusing to play offline
  return {
    uid: randomUUID(),
    displayName: "Trainer",
    metadata: { language: "en" }
  }
}

/** Extracts the bearer token from an HTTP request header value. */
export function tokenFromAuthorizationHeader(
  header: string | undefined
): string | null {
  if (!header) return null
  const [scheme, value] = header.split(" ")
  if (!value) return null
  if (scheme.toLowerCase() !== "bearer") return null
  return value
}

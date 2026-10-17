/**
 * Offline identity for the browser.
 *
 * Replaces Firebase Auth: the player picks a nickname once, we mint a uid,
 * keep both in localStorage and send them to the server as a bearer token.
 * No network call is involved, so the game works with the device in airplane
 * mode (as long as the local server is running).
 */
export interface LocalUser {
  uid: string
  displayName: string
  email?: string
}

const STORAGE_KEY = "pac.local.user"
const TOKEN_PREFIX = "local."

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function createUid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID()
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function getLocalUser(): LocalUser | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.uid) return null
    return {
      uid: String(parsed.uid),
      displayName: String(parsed.displayName || "Trainer")
    }
  } catch {
    return null
  }
}

export function signInLocal(displayName: string, uid?: string): LocalUser {
  const existing = getLocalUser()
  const user: LocalUser = {
    uid: uid ?? existing?.uid ?? createUid(),
    displayName: displayName.trim() || "Trainer"
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(user))
  window.dispatchEvent(new Event("pac-local-auth-changed"))
  return user
}

export function signOutLocal(): void {
  localStorage.removeItem(STORAGE_KEY)
  window.dispatchEvent(new Event("pac-local-auth-changed"))
}

export function createToken(user: LocalUser): string {
  return (
    TOKEN_PREFIX +
    base64UrlEncode(
      JSON.stringify({
        uid: user.uid,
        displayName: user.displayName,
        language: localStorage.getItem("i18nextLng") ?? "en"
      })
    )
  )
}

/** Same shape as the previous `firebase.auth().currentUser?.getIdToken()`. */
export async function getToken(): Promise<string | null> {
  const user = getLocalUser()
  return user ? createToken(user) : null
}

export function onLocalAuthChanged(callback: (user: LocalUser | null) => void) {
  const handler = () => callback(getLocalUser())
  window.addEventListener("pac-local-auth-changed", handler)
  window.addEventListener("storage", handler)
  return () => {
    window.removeEventListener("pac-local-auth-changed", handler)
    window.removeEventListener("storage", handler)
  }
}

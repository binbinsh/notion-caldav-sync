const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function requireMasterKey(value: string | null | undefined): string {
  const normalized = (value || "").trim();
  if (!normalized) {
    throw new Error("APP_ENCRYPTION_KEY must be set for tenant secret storage.");
  }
  const raw = b64urlDecode(normalized);
  if (raw.byteLength !== 32) {
    throw new Error("APP_ENCRYPTION_KEY must decode to 32 bytes for AES-256-GCM.");
  }
  return normalized;
}

export async function encryptSecret(
  plaintext: string,
  masterKey: string,
  aad = "",
): Promise<string> {
  const cryptoKey = await importKey(masterKey, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherBuffer = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: aad ? encoder.encode(aad) : undefined,
    },
    cryptoKey,
    encoder.encode(plaintext),
  );
  const payload = new Uint8Array(iv.byteLength + cipherBuffer.byteLength);
  payload.set(iv, 0);
  payload.set(new Uint8Array(cipherBuffer), iv.byteLength);
  return b64urlEncode(payload);
}

export async function decryptSecret(
  ciphertext: string,
  masterKey: string,
  aad = "",
): Promise<string> {
  const payload = b64urlDecode(ciphertext);
  if (payload.byteLength <= 12) {
    throw new Error("Encrypted payload is truncated.");
  }
  const iv = payload.slice(0, 12);
  const cipher = payload.slice(12);
  const cryptoKey = await importKey(masterKey, ["decrypt"]);
  const plainBuffer = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: aad ? encoder.encode(aad) : undefined,
    },
    cryptoKey,
    cipher,
  );
  return decoder.decode(plainBuffer);
}

async function importKey(masterKey: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const raw = b64urlDecode(masterKey);
  const keyData = new Uint8Array(raw.byteLength);
  keyData.set(raw);
  return crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "AES-GCM" },
    false,
    usages,
  );
}

function b64urlEncode(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(data: string): Uint8Array {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

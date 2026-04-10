import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

let loaded = false;

export function loadLocalEnv(): void {
  if (loaded) {
    return;
  }
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    loaded = true;
    return;
  }
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
  loaded = true;
}

export function requiredEnv(keys: string[]): { ok: boolean; missing: string[] } {
  loadLocalEnv();
  const missing = keys.filter((key) => !process.env[key]);
  return { ok: missing.length === 0, missing };
}

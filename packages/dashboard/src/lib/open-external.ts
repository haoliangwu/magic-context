import { openUrl } from "@tauri-apps/plugin-opener";

const ALLOWED_ORIGIN = "https://docs.cortexkit.io";
const ALLOWED_PATH_PREFIX = "/magic-context/";

function allowedUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== ALLOWED_ORIGIN ||
    !url.pathname.startsWith(ALLOWED_PATH_PREFIX) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(`External URL is not allowed: ${value}`);
  }
  return url;
}

export async function openExternal(value: string): Promise<void> {
  const url = allowedUrl(value);
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    await openUrl(url.href);
  } else {
    window.open(url.href, "_blank", "noopener,noreferrer");
  }
}

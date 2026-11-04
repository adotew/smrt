import type { SmrtApi } from "../electron/preload.ts";

declare global {
  interface Window {
    smrt: SmrtApi;
  }
}

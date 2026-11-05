// Wraps the packaged Apple Silicon app in a disk image with an Applications shortcut to drag it onto.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
const dmg = `release/Smrt-${version}-arm64.dmg`;
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "smrt-dmg-"));
const app = path.join(staging, "Smrt.app");
try {
  execFileSync("ditto", ["release/Smrt-darwin-arm64/Smrt.app", app]);
  fs.symlinkSync("/Applications", path.join(staging, "Applications"));
  execFileSync("hdiutil", ["create", "-volname", "Smrt", "-srcfolder", staging, "-ov", "-format", "ULMO", dmg], {
    stdio: "inherit",
  });
  // Notarizing the signed image covers the app inside; needs `xcrun notarytool store-credentials smrt` once.
  execFileSync("codesign", ["--sign", "Developer ID Application", "--timestamp", dmg], { stdio: "inherit" });
  execFileSync("xcrun", ["notarytool", "submit", dmg, "--keychain-profile", "smrt", "--wait"], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}

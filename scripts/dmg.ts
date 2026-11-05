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
  // The packaged bundle's ad-hoc signature is incomplete, and downloaded apps with a broken one are reported as damaged.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app]);
  fs.symlinkSync("/Applications", path.join(staging, "Applications"));
  execFileSync("hdiutil", ["create", "-volname", "Smrt", "-srcfolder", staging, "-ov", "-format", "ULMO", dmg], {
    stdio: "inherit",
  });
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}

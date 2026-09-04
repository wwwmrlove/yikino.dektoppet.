import path from "node:path";
import { packager } from "@electron/packager";

const appDir = path.resolve(import.meta.dirname, "..");
const outDir = path.resolve(process.argv[2] || path.join(appDir, "release"));

function relativeAppPath(filePath) {
  const normalizedPath = String(filePath).replaceAll("\\", "/");

  // Packager 19 documents this callback as receiving an absolute path, but
  // its Windows copy filter currently supplies package-relative paths such as
  // `/renderer/index.html`. Support both forms so root-only rules stay exact.
  if (normalizedPath.startsWith("/")) {
    return normalizedPath.slice(1);
  }

  if (!path.isAbsolute(filePath)) {
    return normalizedPath.replace(/^\.\//, "");
  }

  return path.relative(appDir, filePath).replaceAll("\\", "/");
}

function isRootPath(relativePath, rootName) {
  return relativePath === rootName || relativePath.startsWith(`${rootName}/`);
}

function ignoreProjectFile(filePath) {
  const relativePath = relativeAppPath(filePath);

  // Only omit build artifacts at the application root. A broad `dist` pattern
  // also removes browser bundles such as node_modules/pixi.js/dist/pixi.js.
  if (["release", "dist", "distribution"].some((name) => isRootPath(relativePath, name))) {
    return true;
  }

  if (isRootPath(relativePath, "assets/voice/backups")) {
    return true;
  }

  if (/^vendor\/live2dcubismcore-5(?:\.|$)/.test(relativePath)) {
    return true;
  }

  // @electron/packager's built-in ignores are not added when an ignore
  // function is supplied, so retain the relevant defaults here.
  return (
    relativePath === ".git" ||
    relativePath.startsWith(".git/") ||
    relativePath === "package-lock.json" ||
    relativePath === "yarn.lock" ||
    relativePath === "pnpm-lock.yaml" ||
    isRootPath(relativePath, "node_modules/.bin") ||
    isRootPath(relativePath, "node_modules/electron") ||
    isRootPath(relativePath, "node_modules/electron-nightly") ||
    relativePath.endsWith(".o") ||
    relativePath.endsWith(".obj") ||
    relativePath.includes("/node_gyp_bins/")
  );
}

const outputs = await packager({
  dir: appDir,
  name: "Yukino Desktop Pet",
  platform: "win32",
  arch: "x64",
  out: outDir,
  overwrite: true,
  prune: true,
  asar: true,
  ignore: ignoreProjectFile,
  electronZipDir: process.env.ELECTRON_ZIP_DIR || undefined,
});

for (const output of outputs) {
  console.log(output);
}

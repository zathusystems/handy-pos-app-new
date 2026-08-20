#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT_DIR = resolve(__dirname, "..");
const BASE_TAURI_CONFIG = join(ROOT_DIR, "src-tauri", "tauri.conf.json");
const TAURI_BINARY = join(
  ROOT_DIR,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tauri.cmd" : "tauri",
);
const BUILD_NUMBER_ENV_KEYS = ["TAURI_DESKTOP_BUILD_NUMBER", "GITHUB_RUN_NUMBER"];
const DRY_RUN = ["1", "true", "yes"].includes(
  String(process.env.TAURI_DESKTOP_BUILD_DRY_RUN || "").toLowerCase(),
);

function readBaseVersion() {
  const config = JSON.parse(readFileSync(BASE_TAURI_CONFIG, "utf8"));
  const version = String(config.version || "").trim();

  if (!version) {
    throw new Error("Missing version in src-tauri/tauri.conf.json");
  }

  return version;
}

function parseSemver(version) {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);

  if (!match) {
    throw new Error(
      `Unsupported version format for desktop CI auto-versioning: ${version}`,
    );
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

function getBuildNumber() {
  for (const envKey of BUILD_NUMBER_ENV_KEYS) {
    const rawValue = String(process.env[envKey] || "").trim();

    if (!rawValue) {
      continue;
    }

    const buildNumber = Number.parseInt(rawValue, 10);
    if (!Number.isInteger(buildNumber) || buildNumber < 1) {
      throw new Error(`Invalid ${envKey} value: ${rawValue}`);
    }

    return {
      buildNumber,
      source: envKey,
    };
  }

  return null;
}

function computeCiVersion(baseVersion, buildNumber) {
  const { major: baseMajor, minor: baseMinor, patch: basePatch } = parseSemver(
    baseVersion,
  );

  let patch = basePatch + buildNumber;
  let minor = baseMinor + Math.floor(patch / 65536);
  patch %= 65536;

  const major = baseMajor + Math.floor(minor / 256);
  minor %= 256;

  if (major > 255) {
    throw new Error(
      `Computed Windows version exceeds MSI limits: ${major}.${minor}.${patch}`,
    );
  }

  return `${major}.${minor}.${patch}`;
}

function createTempConfig(version) {
  const tempDir = mkdtempSync(join(tmpdir(), "handypos-tauri-desktop-build-"));
  const tempConfigPath = join(tempDir, "tauri.desktop.ci.conf.json");

  writeFileSync(
    tempConfigPath,
    `${JSON.stringify({ version }, null, 2)}\n`,
    "utf8",
  );

  return {
    tempDir,
    tempConfigPath,
  };
}

function ensureTauriBinary() {
  if (!existsSync(TAURI_BINARY)) {
    throw new Error(`Tauri CLI binary not found at ${TAURI_BINARY}`);
  }
}

function runBuild() {
  const baseVersion = readBaseVersion();
  const buildInfo = getBuildNumber();
  const forwardedArgs = process.argv.slice(2);

  let tempConfigPath = null;
  let tempDir = null;

  try {
    const tauriArgs = ["build", ...forwardedArgs];

    if (buildInfo) {
      const generatedVersion = computeCiVersion(baseVersion, buildInfo.buildNumber);
      ({ tempConfigPath, tempDir } = createTempConfig(generatedVersion));
      tauriArgs.push("--config", tempConfigPath);

      console.log(
        `Desktop version for this build: ${generatedVersion} (${buildInfo.source}=${buildInfo.buildNumber})`,
      );
    } else {
      console.log(`Desktop version for this build: ${baseVersion}`);
    }

    if (DRY_RUN) {
      console.log(`[dry-run] ${TAURI_BINARY} ${tauriArgs.join(" ")}`);
      return;
    }

    ensureTauriBinary();

    const result = spawnSync(TAURI_BINARY, tauriArgs, {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: "inherit",
    });

    if (typeof result.status === "number" && result.status !== 0) {
      process.exit(result.status);
    }

    if (result.error) {
      throw result.error;
    }
  } finally {
    if (tempDir) {
      rmSync(tempDir, { force: true, recursive: true });
    }
  }
}

try {
  runBuild();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

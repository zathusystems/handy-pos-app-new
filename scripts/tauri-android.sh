#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

resolve_android_home() {
  local configured_android_home="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  if [[ -n "$configured_android_home" ]]; then
    echo "$configured_android_home"
    return 0
  fi

  local candidate
  for candidate in "$HOME/Android/Sdk" "$HOME/.android/sdk" "/usr/lib/android-sdk" "/opt/android-sdk"; do
    if [[ -d "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done

  echo "$HOME/Android/Sdk"
}

SOURCE_ANDROID_HOME="$(resolve_android_home)"
PREFERRED_NDK="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-${NDK_HOME:-}}}"
BASE_TAURI_CONFIG="$ROOT_DIR/src-tauri/tauri.conf.json"
ANDROID_TAURI_CONFIG="$ROOT_DIR/src-tauri/tauri.android.conf.json"
ANDROID_GEN_DIR="$ROOT_DIR/src-tauri/gen/android"
ANDROID_MANIFEST_FILE="$ANDROID_GEN_DIR/app/src/main/AndroidManifest.xml"
ANDROID_TAURI_PROPERTIES_FILE="$ANDROID_GEN_DIR/app/tauri.properties"
ANDROID_VERSION_STATE_FILE="$ROOT_DIR/src-tauri/.android-version-state"
ANDROID_COMMAND_ALREADY_EXECUTED=0
TEMP_ANDROID_BUILD_CONFIG=""
GENERATED_ANDROID_VERSION_NAME=""
GENERATED_ANDROID_VERSION_CODE=""
ANDROID_BUILD_AUTOVERSION=0
ANDROID_TAURI_PROPERTIES_BACKUP=""
ANDROID_TAURI_PROPERTIES_EXISTED=0

ensure_android_camera_manifest() {
  if [[ ! -f "$ANDROID_MANIFEST_FILE" ]]; then
    return 0
  fi

  if ! grep -q 'android.permission.CAMERA' "$ANDROID_MANIFEST_FILE"; then
    python3 - "$ANDROID_MANIFEST_FILE" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
content = path.read_text()
needle = '    <uses-permission android:name="android.permission.INTERNET" />\n'
insert = (
    '    <uses-permission android:name="android.permission.CAMERA" />\n'
    '    <uses-permission android:name="android.permission.VIBRATE" />\n'
)
if needle in content and insert not in content:
    content = content.replace(needle, needle + insert, 1)
    path.write_text(content)
PY
  fi

  if ! grep -q 'android.hardware.camera.any' "$ANDROID_MANIFEST_FILE"; then
    python3 - "$ANDROID_MANIFEST_FILE" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
content = path.read_text()
needle = '    <uses-feature android:name="android.software.leanback" android:required="false" />\n'
insert = (
    '    <uses-feature android:name="android.hardware.camera.any" android:required="false" />\n'
    '    <uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />\n'
)
if needle in content and insert not in content:
    content = content.replace(needle, needle + insert, 1)
    path.write_text(content)
PY
  fi
}

copy_if_exists() {
  local source="$1"
  local destination="$2"
  if [[ -f "$source" ]]; then
    cp -f "$source" "$destination"
  fi
}

backup_android_signing_artifacts() {
  local backup_dir="$1"
  mkdir -p "$backup_dir"

  copy_if_exists "$ANDROID_GEN_DIR/key.properties" "$backup_dir/key.properties"
  copy_if_exists "$ANDROID_GEN_DIR/handypos-release.jks" "$backup_dir/handypos-release.jks"
  copy_if_exists "$ANDROID_TAURI_PROPERTIES_FILE" "$backup_dir/tauri.properties"

  # Also back up any additional keystore files users may provide.
  if [[ -d "$ANDROID_GEN_DIR" ]]; then
    while IFS= read -r key_file; do
      cp -f "$key_file" "$backup_dir/$(basename "$key_file")"
    done < <(find "$ANDROID_GEN_DIR" -maxdepth 1 -type f \( -name "*.jks" -o -name "*.keystore" \))
  fi
}

restore_android_signing_artifacts() {
  local backup_dir="$1"
  if [[ ! -d "$backup_dir" ]]; then
    return 0
  fi

  mkdir -p "$ANDROID_GEN_DIR"
  mkdir -p "$(dirname "$ANDROID_TAURI_PROPERTIES_FILE")"
  while IFS= read -r artifact; do
    local artifact_name
    artifact_name="$(basename "$artifact")"

    if [[ "$artifact_name" == "tauri.properties" ]]; then
      cp -f "$artifact" "$ANDROID_TAURI_PROPERTIES_FILE"
    else
      cp -f "$artifact" "$ANDROID_GEN_DIR/$artifact_name"
    fi
  done < <(find "$backup_dir" -maxdepth 1 -type f)
}

recreate_android_project_if_broken() {
  local android_subcommand="$1"

  # This state blocks both `tauri android init` and build commands:
  # gen/android exists, but app sources are missing.
  if [[ -d "$ANDROID_GEN_DIR" && ! -f "$ANDROID_MANIFEST_FILE" ]]; then
    echo "Detected incomplete Android project at $ANDROID_GEN_DIR."
    echo "Backing up signing artifacts and recreating Android project..."

    local backup_dir
    backup_dir="$(mktemp -d)"
    backup_android_signing_artifacts "$backup_dir"
    rm -rf "$ANDROID_GEN_DIR"

    if [[ "$android_subcommand" == "init" ]]; then
      npx tauri android init --ci --skip-targets-install
      ANDROID_COMMAND_ALREADY_EXECUTED=1
    else
      npx tauri android init --ci --skip-targets-install
    fi

    restore_android_signing_artifacts "$backup_dir"
    rm -rf "$backup_dir"
  fi

  # Fresh environment: initialize project for commands that require it.
  if [[ ! -f "$ANDROID_MANIFEST_FILE" && "$android_subcommand" =~ ^(build|dev|run)$ ]]; then
    echo "Android project not initialized. Running tauri android init..."
    npx tauri android init --ci --skip-targets-install
  fi
}

has_tauri_config_arg() {
  local previous=""
  for arg in "$@"; do
    if [[ "$arg" == --config=* ]]; then
      return 0
    fi
    if [[ "$previous" == "--config" ]]; then
      return 0
    fi
    previous="$arg"
  done
  return 1
}

read_tauri_base_version() {
  python3 - "$BASE_TAURI_CONFIG" <<'PY'
from pathlib import Path
import json
import sys

path = Path(sys.argv[1])
config = json.loads(path.read_text())
version = str(config.get("version") or "").strip()
if not version:
    raise SystemExit("Missing version in src-tauri/tauri.conf.json")

print(version)
PY
}

compute_android_base_version_code() {
  python3 - "$1" <<'PY'
import re
import sys

version = sys.argv[1].split("+", 1)[0].strip()
match = re.match(r"^(\d+)\.(\d+)\.(\d+)(?:[-].*)?$", version)
if not match:
    raise SystemExit(f"Unsupported version format for Android build auto-versioning: {version}")

major, minor, patch = (int(part) for part in match.groups())
print((major * 1_000_000) + (minor * 1_000) + patch)
PY
}

read_android_state_version_code() {
  if [[ ! -f "$ANDROID_VERSION_STATE_FILE" ]]; then
    return 0
  fi

  python3 - "$ANDROID_VERSION_STATE_FILE" <<'PY'
from pathlib import Path
import re
import sys

content = Path(sys.argv[1]).read_text()
match = re.search(r"^versionCode=(\d+)\s*$", content, re.MULTILINE)
if match:
    print(match.group(1))
PY
}

read_android_properties_version_code() {
  if [[ ! -f "$ANDROID_TAURI_PROPERTIES_FILE" ]]; then
    return 0
  fi

  python3 - "$ANDROID_TAURI_PROPERTIES_FILE" <<'PY'
from pathlib import Path
import re
import sys

content = Path(sys.argv[1]).read_text()
match = re.search(r"^tauri\.android\.versionCode=(\d+)\s*$", content, re.MULTILINE)
if match:
    print(match.group(1))
PY
}

compute_next_android_version_code() {
  local base_version="$1"
  local base_version_code
  local state_version_code
  local properties_version_code
  local current_version_code
  base_version_code="$(compute_android_base_version_code "$base_version")"
  current_version_code="$base_version_code"

  state_version_code="$(read_android_state_version_code || true)"
  properties_version_code="$(read_android_properties_version_code || true)"

  if [[ -n "$state_version_code" && "$state_version_code" =~ ^[0-9]+$ && "$state_version_code" -gt "$current_version_code" ]]; then
    current_version_code="$state_version_code"
  fi

  if [[ -n "$properties_version_code" && "$properties_version_code" =~ ^[0-9]+$ && "$properties_version_code" -gt "$current_version_code" ]]; then
    current_version_code="$properties_version_code"
  fi

  echo $((current_version_code + 1))
}

generate_android_build_config() {
  local base_version="$1"
  local next_version_code="$2"
  local temp_config
  local generated_version_name
  temp_config="$(mktemp "${TMPDIR:-/tmp}/handypos-tauri-android-build-config.XXXXXX.json")"
  TEMP_ANDROID_BUILD_CONFIG="$temp_config"

  generated_version_name="$(python3 - "$ANDROID_TAURI_CONFIG" "$temp_config" "$base_version" "$next_version_code" <<'PY'
from pathlib import Path
import json
import sys

source_path = Path(sys.argv[1])
destination_path = Path(sys.argv[2])
base_version = sys.argv[3].strip()
next_version_code = sys.argv[4].strip()

config = json.loads(source_path.read_text()) if source_path.exists() else {}
visible_version = f"{base_version.split('+', 1)[0]}+{next_version_code}"
config["version"] = visible_version
config.setdefault("bundle", {})
config["bundle"].setdefault("android", {})
config["bundle"]["android"]["versionCode"] = int(next_version_code)
config["bundle"]["android"]["autoIncrementVersionCode"] = False

destination_path.write_text(json.dumps(config, indent=2) + "\n")
print(visible_version)
PY
)"
  GENERATED_ANDROID_VERSION_NAME="$generated_version_name"
  GENERATED_ANDROID_VERSION_CODE="$next_version_code"
}

write_android_tauri_properties() {
  local version_name="$1"
  local version_code="$2"

  mkdir -p "$(dirname "$ANDROID_TAURI_PROPERTIES_FILE")"

  python3 - "$ANDROID_TAURI_PROPERTIES_FILE" "$version_name" "$version_code" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
version_name = sys.argv[2].strip()
version_code = sys.argv[3].strip()

lines = []
if path.exists():
    lines = path.read_text().splitlines()

header = "// THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY."
updated_lines = []
header_written = False
version_name_written = False
version_code_written = False

for line in lines:
    if line.startswith("tauri.android.versionName="):
        updated_lines.append(f"tauri.android.versionName={version_name}")
        version_name_written = True
    elif line.startswith("tauri.android.versionCode="):
        updated_lines.append(f"tauri.android.versionCode={version_code}")
        version_code_written = True
    elif line.strip() == header:
        updated_lines.append(header)
        header_written = True
    else:
        updated_lines.append(line)

if not header_written:
    updated_lines.insert(0, header)

if not version_name_written:
    updated_lines.append(f"tauri.android.versionName={version_name}")

if not version_code_written:
    updated_lines.append(f"tauri.android.versionCode={version_code}")

path.write_text("\n".join(updated_lines).rstrip() + "\n")
PY
}

write_android_version_state() {
  local version_name="$1"
  local version_code="$2"

  python3 - "$ANDROID_VERSION_STATE_FILE" "$version_name" "$version_code" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
version_name = sys.argv[2].strip()
version_code = sys.argv[3].strip()

path.write_text(
    "\n".join([
        "# Handy POS Android build version state.",
        "# Commit this file so versionCode increments continue across machines.",
        f"versionName={version_name}",
        f"versionCode={version_code}",
        "",
    ])
)
PY
}

backup_android_tauri_properties_for_build() {
  ANDROID_TAURI_PROPERTIES_BACKUP="$(mktemp)"
  if [[ -f "$ANDROID_TAURI_PROPERTIES_FILE" ]]; then
    ANDROID_TAURI_PROPERTIES_EXISTED=1
    cp -f "$ANDROID_TAURI_PROPERTIES_FILE" "$ANDROID_TAURI_PROPERTIES_BACKUP"
  else
    ANDROID_TAURI_PROPERTIES_EXISTED=0
    : > "$ANDROID_TAURI_PROPERTIES_BACKUP"
  fi
}

restore_android_tauri_properties_after_failed_build() {
  if [[ "$ANDROID_BUILD_AUTOVERSION" != "1" || -z "$ANDROID_TAURI_PROPERTIES_BACKUP" ]]; then
    return 0
  fi

  if [[ "$ANDROID_TAURI_PROPERTIES_EXISTED" == "1" ]]; then
    mkdir -p "$(dirname "$ANDROID_TAURI_PROPERTIES_FILE")"
    cp -f "$ANDROID_TAURI_PROPERTIES_BACKUP" "$ANDROID_TAURI_PROPERTIES_FILE"
  else
    rm -f "$ANDROID_TAURI_PROPERTIES_FILE"
  fi
}

should_sign_release_apks() {
  local has_build=0
  local has_apk=0
  local has_debug=0

  for arg in "$@"; do
    case "$arg" in
      build)
        has_build=1
        ;;
      --apk)
        has_apk=1
        ;;
      --debug|-d)
        has_debug=1
        ;;
    esac
  done

  [[ $has_build -eq 1 && $has_apk -eq 1 && $has_debug -eq 0 ]]
}

find_latest_apksigner() {
  local latest=""
  while IFS= read -r candidate; do
    latest="$candidate"
  done < <(find -L "$ANDROID_HOME/build-tools" -mindepth 2 -maxdepth 2 -type f -name apksigner | sort -V)

  echo "$latest"
}

sign_release_apks() {
  local build_marker_file="$1"
  local signing_file="$ROOT_DIR/src-tauri/gen/android/key.properties"
  if [[ ! -f "$signing_file" ]]; then
    echo "No key.properties found at src-tauri/gen/android/key.properties. Skipping APK signing."
    return 0
  fi

  local store_file=""
  local store_password=""
  local key_alias=""
  local key_password=""

  while IFS='=' read -r key value; do
    case "$key" in
      storeFile) store_file="$value" ;;
      storePassword) store_password="$value" ;;
      keyAlias) key_alias="$value" ;;
      keyPassword) key_password="$value" ;;
    esac
  done < "$signing_file"

  if [[ -z "$store_file" || -z "$store_password" || -z "$key_alias" || -z "$key_password" ]]; then
    echo "Incomplete Android signing configuration in $signing_file"
    return 1
  fi

  local keystore_path="$store_file"
  if [[ "$keystore_path" != /* ]]; then
    keystore_path="$ROOT_DIR/src-tauri/gen/android/$keystore_path"
  fi

  if [[ ! -f "$keystore_path" ]]; then
    echo "Keystore file not found: $keystore_path"
    return 1
  fi

  mapfile -t unsigned_apks < <(find "$ROOT_DIR/src-tauri/gen/android/app/build/outputs/apk" -type f -name "*-unsigned.apk" -newer "$build_marker_file" | sort)

  if [[ ${#unsigned_apks[@]} -eq 0 ]]; then
    echo "No unsigned release APKs generated in this build."
    return 0
  fi

  local apksigner
  apksigner="$(find_latest_apksigner)"
  if [[ -z "$apksigner" || ! -x "$apksigner" ]]; then
    echo "apksigner not found under $ANDROID_HOME/build-tools"
    return 1
  fi

  local ks_pass_file
  local key_pass_file
  ks_pass_file="$(mktemp)"
  key_pass_file="$(mktemp)"
  trap 'rm -f "$ks_pass_file" "$key_pass_file"' RETURN

  printf '%s' "$store_password" > "$ks_pass_file"
  printf '%s' "$key_password" > "$key_pass_file"

  echo "Signing release APKs..."

  for unsigned_apk in "${unsigned_apks[@]}"; do
    local signed_apk="${unsigned_apk%-unsigned.apk}.apk"

    "$apksigner" sign \
      --ks "$keystore_path" \
      --ks-key-alias "$key_alias" \
      --ks-pass "file:$ks_pass_file" \
      --key-pass "file:$key_pass_file" \
      --out "$signed_apk" \
      "$unsigned_apk"

    "$apksigner" verify "$signed_apk" >/dev/null
    echo "Signed: $signed_apk"
  done
}

if [[ ! -d "$SOURCE_ANDROID_HOME" ]]; then
  echo "ANDROID_HOME not found: $SOURCE_ANDROID_HOME"
  echo "Set ANDROID_HOME to your Android SDK path."
  exit 1
fi

if [[ ! -d "$SOURCE_ANDROID_HOME/ndk" ]]; then
  echo "No NDK directory found at: $SOURCE_ANDROID_HOME/ndk"
  echo "Install Android NDK from Android Studio SDK Manager."
  exit 1
fi

if [[ -n "$PREFERRED_NDK" ]]; then
  if [[ -f "$PREFERRED_NDK/source.properties" ]]; then
    VALID_NDKS=("$PREFERRED_NDK")
  else
    echo "Preferred NDK path is invalid or missing source.properties: $PREFERRED_NDK"
    exit 1
  fi
else
  mapfile -t VALID_NDKS < <(
    find "$SOURCE_ANDROID_HOME/ndk" -mindepth 1 -maxdepth 1 -type d \
      -exec test -f "{}/source.properties" ';' -print | sort -V
  )
fi

if [[ ${#VALID_NDKS[@]} -eq 0 ]]; then
  echo "No valid NDK installations found under: $SOURCE_ANDROID_HOME/ndk"
  echo "Expected source.properties inside an NDK version directory."
  exit 1
fi

LAST_INDEX=$((${#VALID_NDKS[@]} - 1))
SELECTED_NDK="${VALID_NDKS[$LAST_INDEX]}"
MIRROR_ANDROID_HOME="/tmp/handypos-android-sdk"

rm -rf "$MIRROR_ANDROID_HOME"
mkdir -p "$MIRROR_ANDROID_HOME"

# Mirror only required SDK folders and a single valid NDK to avoid broken partial installs.
for dir_name in build-tools cmdline-tools emulator licenses platform-tools platforms; do
  if [[ -e "$SOURCE_ANDROID_HOME/$dir_name" ]]; then
    ln -s "$SOURCE_ANDROID_HOME/$dir_name" "$MIRROR_ANDROID_HOME/$dir_name"
  fi
done

mkdir -p "$MIRROR_ANDROID_HOME/ndk"
ln -s "$SELECTED_NDK" "$MIRROR_ANDROID_HOME/ndk/$(basename "$SELECTED_NDK")"

export ANDROID_HOME="$MIRROR_ANDROID_HOME"
export ANDROID_NDK_HOME="$SELECTED_NDK"
export ANDROID_NDK_ROOT="$SELECTED_NDK"
export NDK_HOME="$SELECTED_NDK"
export ANDROID_SDK_ROOT="$ANDROID_HOME"

cd "$ROOT_DIR"

echo "Using ANDROID_HOME=$ANDROID_HOME"
echo "Using NDK=$SELECTED_NDK"

BUILD_MARKER_FILE="$(mktemp)"
trap 'rm -f "$BUILD_MARKER_FILE" "$TEMP_ANDROID_BUILD_CONFIG" "$ANDROID_TAURI_PROPERTIES_BACKUP"' EXIT

TAURI_ARGS=("$@")
ANDROID_SUBCOMMAND="${1:-}"
recreate_android_project_if_broken "$ANDROID_SUBCOMMAND"
ensure_android_camera_manifest

if [[ "$ANDROID_SUBCOMMAND" == "build" ]] && [[ -f "$ANDROID_TAURI_CONFIG" ]] && ! has_tauri_config_arg "${TAURI_ARGS[@]}"; then
  BASE_TAURI_VERSION="$(read_tauri_base_version)"
  NEXT_ANDROID_VERSION_CODE="$(compute_next_android_version_code "$BASE_TAURI_VERSION")"
  generate_android_build_config "$BASE_TAURI_VERSION" "$NEXT_ANDROID_VERSION_CODE"
  backup_android_tauri_properties_for_build
  ANDROID_BUILD_AUTOVERSION=1

  TAURI_ARGS+=(--config "$TEMP_ANDROID_BUILD_CONFIG")
  export NEXT_PUBLIC_APP_VERSION="$GENERATED_ANDROID_VERSION_NAME"
  echo "Using Android Tauri config: $TEMP_ANDROID_BUILD_CONFIG"
  echo "Android versionName for this build: $GENERATED_ANDROID_VERSION_NAME"
  echo "Android versionCode for this build: $NEXT_ANDROID_VERSION_CODE"
elif [[ "$ANDROID_SUBCOMMAND" =~ ^(build|dev|run)$ ]] && [[ -f "$ANDROID_TAURI_CONFIG" ]] && ! has_tauri_config_arg "${TAURI_ARGS[@]}"; then
  TAURI_ARGS+=(--config "$ANDROID_TAURI_CONFIG")
  echo "Using Android Tauri config: $ANDROID_TAURI_CONFIG"
fi

if [[ "$ANDROID_COMMAND_ALREADY_EXECUTED" == "1" ]]; then
  echo "Android init completed during repair."
else
  set +e
  npx tauri android "${TAURI_ARGS[@]}"
  TAURI_ANDROID_STATUS=$?
  set -e

  if [[ "$TAURI_ANDROID_STATUS" -ne 0 ]]; then
    restore_android_tauri_properties_after_failed_build
    exit "$TAURI_ANDROID_STATUS"
  fi
fi

if [[ "$ANDROID_BUILD_AUTOVERSION" == "1" ]]; then
  write_android_tauri_properties "$GENERATED_ANDROID_VERSION_NAME" "$GENERATED_ANDROID_VERSION_CODE"
  write_android_version_state "$GENERATED_ANDROID_VERSION_NAME" "$GENERATED_ANDROID_VERSION_CODE"
  echo "Persisted Android versionName: $GENERATED_ANDROID_VERSION_NAME"
  echo "Persisted Android versionCode: $GENERATED_ANDROID_VERSION_CODE"
fi

ensure_android_camera_manifest

if should_sign_release_apks "${TAURI_ARGS[@]}"; then
  sign_release_apks "$BUILD_MARKER_FILE"
fi

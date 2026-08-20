#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT_DIR/src-tauri/gen/android"
KEY_PROPERTIES_FILE="$ANDROID_DIR/key.properties"

if [[ ! -d "$ANDROID_DIR" ]]; then
  echo "Android project not found at $ANDROID_DIR"
  echo "Run: npm run tauri:android:init"
  exit 1
fi

if [[ -f "$KEY_PROPERTIES_FILE" && "${FORCE_ANDROID_SIGNING_SETUP:-0}" != "1" ]]; then
  echo "Android signing already configured at src-tauri/gen/android/key.properties"
  exit 0
fi

if ! command -v keytool >/dev/null 2>&1; then
  echo "keytool is required but not found. Install JDK 17+ and retry."
  exit 1
fi

KEY_ALIAS="${ANDROID_KEY_ALIAS:-handypos}"
if [[ -n "${ANDROID_KEYSTORE_PASSWORD:-}" ]]; then
  STORE_PASSWORD="$ANDROID_KEYSTORE_PASSWORD"
elif command -v openssl >/dev/null 2>&1; then
  STORE_PASSWORD="$(openssl rand -hex 16)"
else
  STORE_PASSWORD="$(date +%s%N | sha256sum | cut -c1-32)"
fi
# PKCS12 keystores use one password for both store and key.
KEY_PASSWORD="$STORE_PASSWORD"
KEYSTORE_FILE="${ANDROID_KEYSTORE_PATH:-$ANDROID_DIR/handypos-release.jks}"

if [[ "$KEYSTORE_FILE" != /* ]]; then
  KEYSTORE_FILE="$ROOT_DIR/$KEYSTORE_FILE"
fi

mkdir -p "$(dirname "$KEYSTORE_FILE")"

if [[ ! -f "$KEYSTORE_FILE" ]]; then
  keytool -genkeypair -v \
    -keystore "$KEYSTORE_FILE" \
    -storetype PKCS12 \
    -alias "$KEY_ALIAS" \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -storepass "$STORE_PASSWORD" \
    -keypass "$KEY_PASSWORD" \
    -dname "CN=Handy POS, OU=POS, O=Handy POS, L=Lilongwe, ST=Central, C=MW"
fi

STORE_FILE_PROPERTY="$KEYSTORE_FILE"
if [[ "$KEYSTORE_FILE" == "$ANDROID_DIR/"* ]]; then
  STORE_FILE_PROPERTY="${KEYSTORE_FILE#"$ANDROID_DIR/"}"
fi

cat > "$KEY_PROPERTIES_FILE" <<PROPS
storeFile=$STORE_FILE_PROPERTY
storePassword=$STORE_PASSWORD
keyAlias=$KEY_ALIAS
keyPassword=$KEY_PASSWORD
PROPS

chmod 600 "$KEY_PROPERTIES_FILE" "$KEYSTORE_FILE"

echo "Android signing configured."
echo "Keystore: $KEYSTORE_FILE"
echo "Properties: $KEY_PROPERTIES_FILE"

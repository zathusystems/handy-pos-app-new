#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKEND_DIR="${PROJECT_ROOT}/backend"
REPORT_PATH="${PROJECT_ROOT}/docs/mra-eis/dry-readiness-latest.json"

cd "${BACKEND_DIR}"

export DJANGO_SETTINGS_MODULE=core.settings_test
export MRA_EIS_MODE=TEST
export MRA_EIS_DRY_RUN=True
export MRA_EIS_ALLOW_LIVE_SUBMISSION=False
export MRA_EIS_ENABLE_HTTP_CALLS=True

python3 manage.py migrate --noinput
python3 manage.py mra_eis_dry_readiness --output "${REPORT_PATH}" "$@"

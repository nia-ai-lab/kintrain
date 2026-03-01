#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.local}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE"
  echo "Create it from .env.example"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -z "${AMPLIFY_IDENTIFIER:-}" ]]; then
  echo "AMPLIFY_IDENTIFIER is required in $ENV_FILE"
  exit 1
fi

if [[ -n "${AWS_PROFILE:-}" ]]; then
  export AWS_PROFILE
fi

if [[ -n "${AWS_REGION:-}" ]]; then
  export AWS_REGION
fi

cd "$ROOT_DIR"
npx ampx sandbox --once --identifier "$AMPLIFY_IDENTIFIER"
npx ampx generate outputs
cp amplify_outputs.json frontend/src/amplify_outputs.json

echo "Backend deploy complete."

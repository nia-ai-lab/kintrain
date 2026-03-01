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

if [[ -z "${AWS_PROFILE:-}" ]]; then
  unset AWS_PROFILE || true
fi

if [[ -z "${AWS_REGION:-}" ]]; then
  unset AWS_REGION || true
fi

if [[ -z "${AWS_APP_ID:-}" ]]; then
  echo "AWS_APP_ID is required in $ENV_FILE"
  exit 1
fi

AMPLIFY_BRANCH="${AMPLIFY_BRANCH:-dev}"

if [[ -n "${AWS_PROFILE:-}" ]]; then
  export AWS_PROFILE
fi

if [[ -n "${AWS_REGION:-}" ]]; then
  export AWS_REGION
fi

cd "$ROOT_DIR"
if npx ampx generate outputs --app-id "$AWS_APP_ID" --branch "$AMPLIFY_BRANCH" --format json --out-dir "$ROOT_DIR"; then
  cp "$ROOT_DIR/amplify_outputs.json" "$ROOT_DIR/frontend/src/amplify_outputs.json"
  echo "Synced outputs for branch '$AMPLIFY_BRANCH' to frontend/src/amplify_outputs.json (via ampx)"
  exit 0
fi

echo "ampx generate outputs failed. Falling back to AWS CLI customOutputs merge..."

BRANCH_JSON="$(aws amplify get-branch --app-id "$AWS_APP_ID" --branch-name "$AMPLIFY_BRANCH" --output json)"
STACK_ARN="$(echo "$BRANCH_JSON" | jq -r '.branch.backend.stackArn // empty')"
if [[ -z "$STACK_ARN" ]]; then
  echo "Unable to resolve backend stack ARN from amplify branch '$AMPLIFY_BRANCH'."
  exit 1
fi

STACK_OUTPUTS="$(aws cloudformation describe-stacks --stack-name "$STACK_ARN" --query 'Stacks[0].Outputs' --output json)"
CUSTOM_OUTPUTS_RAW="$(echo "$STACK_OUTPUTS" | jq -r '.[] | select(.OutputKey=="customOutputs") | .OutputValue')"

if [[ -z "$CUSTOM_OUTPUTS_RAW" || "$CUSTOM_OUTPUTS_RAW" == "null" ]]; then
  echo "customOutputs was not found in CloudFormation stack outputs."
  exit 1
fi

TMP_FILE="$(mktemp)"
CUSTOM_OUTPUTS_JSON="$(echo "$CUSTOM_OUTPUTS_RAW" | jq '.')"

jq \
  --argjson custom "$CUSTOM_OUTPUTS_JSON" \
  '.custom = $custom.custom | .version = ($custom.version // .version // "1.4")' \
  "$ROOT_DIR/frontend/src/amplify_outputs.json" > "$TMP_FILE"

cp "$TMP_FILE" "$ROOT_DIR/amplify_outputs.json"
cp "$TMP_FILE" "$ROOT_DIR/frontend/src/amplify_outputs.json"
rm -f "$TMP_FILE"

echo "Synced outputs for branch '$AMPLIFY_BRANCH' to frontend/src/amplify_outputs.json (via AWS CLI fallback)"

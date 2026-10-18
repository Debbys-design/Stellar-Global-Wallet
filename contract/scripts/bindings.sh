#!/usr/bin/env bash
#
# Build the globe-wallet contract wasm and generate TypeScript bindings
# into packages/bindings/globe-wallet.
#
# Usage: contract/scripts/bindings.sh
#
# Requires the Stellar CLI (https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli)
# with the `contract bindings typescript` subcommand available.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${CONTRACT_DIR}/.." && pwd)"

WASM_PATH="${CONTRACT_DIR}/target/wasm32-unknown-unknown/release/globe_wallet.wasm"
OUTPUT_DIR="${REPO_ROOT}/packages/bindings/globe-wallet"

if ! command -v stellar >/dev/null 2>&1; then
  echo "error: 'stellar' CLI not found on PATH. Install it from https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli" >&2
  exit 1
fi

echo "==> Building globe-wallet contract wasm"
(
  cd "${CONTRACT_DIR}"
  stellar contract build
)

if [[ ! -f "${WASM_PATH}" ]]; then
  echo "error: expected wasm at ${WASM_PATH} but it was not produced by 'stellar contract build'" >&2
  exit 1
fi

echo "==> Generating TypeScript bindings into ${OUTPUT_DIR}"
mkdir -p "${OUTPUT_DIR}"
stellar contract bindings typescript \
  --wasm "${WASM_PATH}" \
  --output-dir "${OUTPUT_DIR}" \
  --overwrite

echo "==> Done. Bindings written to ${OUTPUT_DIR}"

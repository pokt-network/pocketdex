#!/bin/bash

. scripts/shared.sh

# Detect script path
SCRIPT_DIR=$(dirname "$(readlink -f "$0")")

# Create a temporary directory for storing .tgz files
TEMP_TGZ_DIR="$SCRIPT_DIR/../temp_tgz"
mkdir -p "$TEMP_TGZ_DIR"

# Cleanup temporary files
cleanup() {
  info_log "Cleaning up temporary .tgz files and temp directory"
  rm -rf "$TEMP_TGZ_DIR"
}
trap cleanup EXIT

# Save the current NODE_ENV and set it to development
NODE_ENV_BACKUP=$NODE_ENV
export NODE_ENV=development
info_log "Changed NODE_ENV to development"

# Execute yarn at root
info_log "Executing 'yarn' at the root directory"
yarn > /dev/null || { info_log "Failed to execute 'yarn' at root. Exiting."; exit 1; }

# Execute yarn install & build at vendor/cosmjs
info_log "Navigating to vendor/cosmjs to execute 'yarn install' and 'yarn build'"
cd "$SCRIPT_DIR/../vendor/cosmjs" || { info_log "Failed to navigate to vendor/cosmjs. Exiting."; exit 1; }
yarn install > /dev/null || { info_log "Failed to execute 'yarn install' at vendor/cosmjs. Exiting."; exit 1; }
yarn build > /dev/null || { info_log "Failed to execute 'yarn build' at vendor/cosmjs. Exiting."; exit 1; }

# Execute yarn install at vendor/subql
info_log "Navigating to vendor/subql to execute 'yarn install'"
cd "$SCRIPT_DIR/../vendor/subql" || { info_log "Failed to navigate to vendor/subql. Exiting."; exit 1; }
yarn install > /dev/null || { info_log "Failed to execute 'yarn install' at vendor/subql. Exiting."; exit 1; }
yarn build > /dev/null || { info_log "Failed to execute 'yarn build' at vendor/subql. Exiting."; exit 1; }

# Execute yarn install at vendor/subql-cosmos
info_log "Navigating to vendor/subql-cosmos to execute 'yarn install'"
cd "$SCRIPT_DIR/../vendor/subql-cosmos" || { info_log "Failed to navigate to vendor/subql-cosmos. Exiting."; exit 1; }
yarn install > /dev/null || { info_log "Failed to execute 'yarn install' at vendor/subql-cosmos. Exiting."; exit 1; }

# A function to process packages
process_packages() {
  local PACKAGE_DIR=$1
  local MODULE_PREFIX=$2
  local TARGET_DIRS=("${@:3}")

  info_log "Processing packages in $PACKAGE_DIR with module prefix $MODULE_PREFIX"
  for PACKAGE_PATH in "$PACKAGE_DIR/packages"/*; do
    if [ -d "$PACKAGE_PATH" ]; then
      PACKAGE_JSON="$PACKAGE_PATH/package.json"
      if [ -f "$PACKAGE_JSON" ]; then
        NAME=$(jq -r .name "$PACKAGE_JSON")
        VERSION=$(jq -r .version "$PACKAGE_JSON")

        # Skip @subql/utils
        if [[ "$NAME" == "@subql/utils" ]]; then
          info_log "Skipping $NAME@$VERSION (no pack/unpack required)"
          continue
        fi

        # Sanitize NAME to replace / with -
        SANITIZED_NAME=${NAME//\//-}

        TARBALL="$TEMP_TGZ_DIR/$SANITIZED_NAME-$VERSION.tgz"

        info_log "Packing $NAME@$VERSION into $TARBALL"
        cd "$PACKAGE_PATH" || { info_log "Failed to navigate to $PACKAGE_PATH. Skipping."; continue; }
        # Suppress yarn pack logs
        yarn pack --out "$TARBALL" > /dev/null 2>&1 || { info_log "Failed to pack $PACKAGE_PATH. Skipping."; continue; }

        info_log "Decompressing $NAME@$VERSION from $TARBALL"
        for TARGET_DIR in "${TARGET_DIRS[@]}"; do
          # Extract scope & package name
          SCOPE=$(echo "$NAME" | grep -o '^@[^/]*/')   # Matches the scope (e.g., @subql/)
          SCOPE=${SCOPE%/}                             # Remove trailing "/" from @subql/
          PACKAGE=$(echo "$NAME" | sed "s|$SCOPE/||")  # Extract package name (e.g., common-substrate)

          # Construct the target directory under node_modules, e.g., node_modules/@subql/common-substrate
          FULL_TARGET_DIR="$TARGET_DIR/$SCOPE/$PACKAGE"

          if [ -d "$TARGET_DIR/$SCOPE" ]; then
            info_log "  -> Decompressing $NAME@$VERSION into $FULL_TARGET_DIR"
            mkdir -p "$FULL_TARGET_DIR"
            tar -xzf "$TARBALL" --strip-components=1 -C "$FULL_TARGET_DIR" || {
              info_log "    [ERROR] Failed to decompress $TARBALL to $FULL_TARGET_DIR. Skipping."
              continue
            }
          else
            info_log "  -> Skipping decompression for $FULL_TARGET_DIR (target scope directory not found)"
          fi
        done
        cd - > /dev/null # Return to the previous directory silently
      else
        info_log "Skipping $PACKAGE_PATH (no package.json found)"
      fi
    fi
  done
}

# Process packages for vendor/cosmjs
info_log "Processing packages for vendor/cosmjs"
process_packages \
  "$SCRIPT_DIR/../vendor/cosmjs" \
  "@cosmjs" \
  "$SCRIPT_DIR/../vendor/subql/node_modules" \
  "$SCRIPT_DIR/../vendor/subql-cosmos/node_modules" \
  "$SCRIPT_DIR/../node_modules"

# Process packages for vendor/subql
info_log "Processing packages for vendor/subql"
process_packages \
  "$SCRIPT_DIR/../vendor/subql" \
  "@subql" \
  "$SCRIPT_DIR/../vendor/subql-cosmos/node_modules" \
  "$SCRIPT_DIR/../node_modules"

# Run yarn build at vendor/subql-cosmos
info_log "Running 'yarn build' at vendor/subql-cosmos"
cd "$SCRIPT_DIR/../vendor/subql-cosmos" || { info_log "Failed to navigate to vendor/subql-cosmos for build. Exiting."; exit 1; }
yarn build || { info_log "Failed to execute 'yarn build' at vendor/subql-cosmos. Exiting."; exit 1; }

# Process packages for vendor/subql-cosmos
info_log "Processing packages for vendor/subql-cosmos"
process_packages \
  "$SCRIPT_DIR/../vendor/subql-cosmos" \
  "@subql" \
  "$SCRIPT_DIR/../node_modules"

# Restore the original NODE_ENV value
export NODE_ENV=$NODE_ENV_BACKUP
info_log "Restored NODE_ENV to $NODE_ENV_BACKUP"

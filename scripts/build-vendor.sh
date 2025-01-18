#!/bin/bash

# Exit immediately on error
set -e

. scripts/shared.sh

# Variables to hold created `.tgz` files for cleanup
declare -a created_files

# Cleanup function to remove `.tgz` files
cleanup() {
  info_log "Cleanup triggered..."

  # Remove created .tgz files
  for file in "${created_files[@]}"; do
    if [ -e "$file" ]; then
      info_log "Removing file: $file"
      rm -f "$file"
    fi
  done

  info_log "Cleanup of .tgz files complete."
}

# Trap for unexpected exits or user interruptions
trap cleanup EXIT

# Navigate to the base directory for packages
cd vendor/subql/packages

# hold the original value
nodeEnv=$NODE_ENV
# the yarn pack need to have this on production for some of them and because we use this to distribute subql on subql-cosmos
# its ok.
export NODE_ENV=production
# Step 1: Loop through each package folder
for packageDir in */; do
  # Enter the package directory
  cd "$packageDir"

  # Get the package name and version using jq
  packageName=$(jq -r '.name' package.json)
  packageVersion=$(jq -r '.version' package.json)
  info_log "Processing package: $packageName@$packageVersion"

  # Replace slashes in the package name with dashes
  sanitizedPackageName=${packageName//\//-}

  # Define the name of the .tgz file to be created
  tgzFile="${sanitizedPackageName}-${packageVersion}.tgz"

  # Run yarn pack and specify the output file
  info_log "Running 'yarn pack --out $tgzFile' in $packageDir..."
  yarn pack --out "$tgzFile"

  # Track the .tgz file for cleanup
  created_files+=("$tgzFile")

  # Define the target directory for extraction
  targetDir="../../../subql-cosmos/node_modules/@subql/$(basename "$packageName")"

  # Create the target directory
  info_log "Creating target directory: $targetDir"
  mkdir -p "$targetDir"

  # Extract the .tgz file to the target directory
  info_log "Extracting $tgzFile to $targetDir..."
  tar -xzf "$tgzFile" -C "$targetDir" --strip-components=1

  # Cleanup the .tgz file after extraction
  info_log "Cleaning up $tgzFile..."
  rm "$tgzFile"
  # Remove it from the cleanup list since it has now been handled
  created_files=("${created_files[@]/$tgzFile}")

  # Navigate back to vendor/subql/packages
  cd ..
done
# set what it was again.
export NODE_ENV=$nodeEnv

# Step 2: Move to vendor/subql-cosmos and run yarn build
info_log "Switching to 'vendor/subql-cosmos'..."
cd ../../subql-cosmos

info_log "Running 'yarn build' in vendor/subql-cosmos..."
yarn build

# Disable the EXIT trap since everything was successful and cleanup is complete
trap - EXIT

info_log "All steps completed successfully! No .tgz files remain."

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

# Function to process packages in a given directory
process_packages() {
  local baseDir="$1"   # Base directory of packages
  local extractTarget="$2" # Target directory for extracting packages

  # Hold the original NODE_ENV value
  local originalNodeEnv=$NODE_ENV
  export NODE_ENV=production

  cd "$baseDir"

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
    targetDir="$extractTarget/$(basename "$packageName")"

    # Create the target directory
    info_log "Creating target directory: $targetDir"
    mkdir -p "$targetDir"

    # Extract the .tgz file to the target directory
    info_log "Extracting $tgzFile to $targetDir..."
    tar -xzf "$tgzFile" -C "$targetDir" --strip-components=1

    # Cleanup the .tgz file after extraction
    info_log "Cleaning up $tgzFile..."
    rm "$tgzFile"
    created_files=("${created_files[@]/$tgzFile}")

    pwd

    # Navigate back to the base directory
    cd ../
  done

  cd ../../../

  # Restore the original NODE_ENV value
  export NODE_ENV=$originalNodeEnv
}

# Function to handle the post-processing build task
run_post_build() {
  local buildDir="$1"

  info_log "Switching to '$buildDir'..."
  cd "$buildDir"

  info_log "Running 'yarn build' in $buildDir..."
  yarn build
}

# Process packages in vendor/cosmjs/packages and extract to node_modules/@cosmjs and packages/subql-cosmos/node_modules/@cosmjs
# TODO: figure out how to avoid that
# cosmjs need to be built before do this, and before build, need to be install, but the install need to be done before the pocketdex repo.
#process_packages "vendor/cosmjs/packages" "../../../../node_modules/@cosmjs"
#process_packages "vendor/cosmjs/packages" "../../../subql-cosmos/node_modules/@cosmjs"
#process_packages "vendor/cosmjs/packages" "../../../subql/node_modules/@cosmjs"

# Process packages in vendor/subql/packages and extract to subql-cosmos/node_modules/@subql
process_packages "vendor/subql/packages" "../../../subql-cosmos/node_modules/@subql"

# Post-build step for vendor/subql-cosmos
run_post_build "vendor/subql-cosmos"

# Disable the EXIT trap since everything was successful and cleanup is complete
trap - EXIT

info_log "All steps completed successfully! No .tgz files remain."

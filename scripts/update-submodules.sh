#!/bin/bash

. scripts/shared.sh

# Check if DOCKER_IMAGE is set to "true"
if [ "$DOCKER_BUILD" = "true" ]; then
  info_log "Skipping script execution: DOCKER_IMAGE is set to 'true'."
  exit 0
fi

# Warning about cleaning all submodules
warning_log "WARNING: This script will reset and clean ALL submodule directories."
warning_log "This will remove ALL untracked files and changes in submodules."
read -p "Do you want to proceed and clean all submodules? (yes/no): " user_confirmation

if [[ "$user_confirmation" != "yes" ]]; then
  info_log "Operation canceled by the user."
  exit 0
fi

# Prepare for updating submodules
info_log "Starting to clean and update submodules."

# Step 1: Load submodule paths
submodule_paths=($(grep -E "path =" .gitmodules | awk '{print $3}'))

# Debug log for submodules
info_log "Found the following submodules: ${submodule_paths[*]}"

# Step 2: Clean all submodules
for path in "${submodule_paths[@]}"; do
  # Skip if the submodule directory does not exist
  if [[ ! -d "$path" ]]; then
    warning_log "Submodule path $path does not exist. Skipping..."
    continue
  fi

  info_log "Cleaning submodule $path..."
  git -C "$path" reset --hard || error_log "Failed to reset submodule $path!"
  git -C "$path" clean -fdx || error_log "Failed to clean submodule $path!"
  info_log "Submodule $path cleaned successfully."
done

# Step 3: Initialize and update all submodules
info_log "Initializing and updating all submodules..."
git submodule update --init --recursive || error_log "Failed to update submodules! Please resolve the issues manually and try again."

info_log "Successfully initialized and updated submodules."

# Step 4: Ensure submodules are on the correct branch
info_log "Ensuring submodules are on the correct branches (if specified in .gitmodules)..."
submodule_branches=($(grep -E "branch =" .gitmodules | awk '{print $3}'))

# Verify the paths and branches arrays match
if [[ ${#submodule_paths[@]} != ${#submodule_branches[@]} ]]; then
  error_log "Mismatch between submodule paths and branches in .gitmodules. Please fix the file!"
  exit 1
fi

# Step 5: Align submodules to their branches
for ((i = 0; i < ${#submodule_paths[@]}; i++)); do
  path="${submodule_paths[$i]}"
  branch="${submodule_branches[$i]}"

  if [[ -n "$branch" ]]; then
    info_log "Checking out and updating branch $branch for submodule $path..."
    git -C "$path" checkout "$branch" || error_log "Failed to checkout branch $branch for submodule $path!"
    git -C "$path" pull || error_log "Failed to pull changes for submodule $path!"
  else
    warning_log "No branch specified for submodule $path. Skipping branch checkout."
  fi
done

info_log "All submodules updated successfully."

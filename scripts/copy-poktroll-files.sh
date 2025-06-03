#!/bin/sh

set -e

DIR="$(dirname "$0")"
if [ ! -d "$DIR" ]; then
  DIR="$PWD"
fi
DIR="$(cd "$DIR" && pwd)"

. ${DIR}/shared.sh

# Create a temp directory to clone poktroll into
WORK_DIR=$(mktemp -d -p "${DIR}")
# Normalize WORK_DIR to absolute path
WORK_DIR=$(cd "$WORK_DIR" && pwd)

if [ -z "$WORK_DIR" ]; then
  error_log "Could not create temp dir"
  exit 1
fi

info_log "Working in $WORK_DIR"

cleanup() {
  info_log "Cleaning up..."
  rm -rf "$WORK_DIR"
  info_log "Cleanup done. Poktroll directory was deleted."
}

# Remove the temp directory on exit
trap cleanup EXIT

default_branch="main"
branch=${1:-$default_branch}

cd ${WORK_DIR}

info_log "Cloning Poktroll from github.com/pokt-network/poktroll..."
git clone https://github.com/pokt-network/poktroll.git

info_log "Poktroll from github.com/pokt-network/poktroll was cloned."
cd poktroll

if [ "$branch" != "$default_branch" ]; then
  info_log "Checking out $branch branch in Poktroll repository..."
  git checkout $branch
fi

cd ..

# Deleting old protobuf source files.
rm -rf ${DIR}/../proto/pocket/*
# Copying proto files
cp -TR poktroll/proto/pocket/ ${DIR}/../proto/pocket

info_log "Proto files were copied."


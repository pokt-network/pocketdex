#!/bin/sh

set -e

DIR="$(dirname "$0")"
if [ ! -d "$DIR" ]; then
  DIR="$PWD"
fi

. ${DIR}/shared.sh

if ! command -v ignite >/dev/null 2>&1; then
  error_log "Ignite is not installed. Please install it at: https://docs.ignite.com/welcome/install."
  exit 1
fi

default_branch="main"
branch=${1:-$default_branch}

rm -rf poktroll
info_log "Poktroll github repository is going to be clone..."
git clone https://github.com/pokt-network/poktroll.git
{
  info_log "Poktroll github repository is cloned..."
  cd poktroll

  if [ "$branch" != "$default_branch" ]; then
    info_log "Poktroll github repository is going to be checkout to $branch branch..."
    git checkout $branch
  fi

  info_log "TypeScript client files will be generated..."
  echo "Y" | ignite generate ts-client --yes --use-cache

  info_log "TypeScript client files were generated. Now copying them to the project..."
  cd ..
  rm -rf ${DIR}/../src/client
  mkdir -p ${DIR}/../src/client

  # Here we are copying the files from poktroll.application because every directory copied has the types directory with the same files inside.
  cp -TR poktroll/ts-client/poktroll.application/types ${DIR}/../src/client
  rm -f ${DIR}/../src/client/route-name.eta

  info_log "TypeScript client files were copied. Now copying proto files..."

  rm -rf ${DIR}/../proto/poktroll
  mkdir -p ${DIR}/../proto/poktroll
  cp -TR poktroll/proto/poktroll/ ${DIR}/../proto/poktroll
  git add ${DIR}/../proto/poktroll

  info_log "Proto files were copied."
  rm -rf poktroll
  info_log "Poktroll folder cloned from github was deleted."
} || rm -rf poktroll

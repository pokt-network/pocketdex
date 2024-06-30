#!/bin/sh

set -e

### This script was made to avoid type all this commands on package.json script section for the script `build`

. scripts/shared.sh

info_log "Running 'subql' codegen"
yarn exec subql codegen # this is same of yarn exec subql codegen

# poktroll has some entities that use bigint as keys which is not supported in typescript so to avoid that issue
# it will find and replace with a number instead.
info_log "Applying proto-interfaces replace from 'key: bigint' to 'key: number' due to typescript issues."
find ./src/types/proto-interfaces/poktroll -type f -name '*.ts' -exec sed -i 's/\[key: bigint\]/\[key: number\]/g' {} \;

info_log "Running 'subql' build"
yarn exec subql build

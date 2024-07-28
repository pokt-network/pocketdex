#!/bin/sh

set -e

. scripts/shared.sh

# Check if .env.sample exists
if [ ! -f .env.sample ]; then
    warning_log ".env.sample does not exist. Skipping automatic dotenv files creation"
else
  # Define environments
  environments="development production test"

  for environment in $environments
  do
    # Create a copy of .env.sample for each environment
    cp .env.sample .env.$environment

    # Replace ENV= with ENV=<environment> in each file
    # The command differs depending on the Unix-based system (Linux/BSD) or Mac, due to differences in the sed command
    # - On GNU sed (default on Linux), no space is used between -i and '' (or ""): sed -i'' 's/foo/bar/g'.
    # - On BSD sed (default on MacOS), a space is required between -i and '' (or ""): sed -i '' 's/foo/bar/g'.
    if [ "$(uname)" = "Darwin" ]; then
      # Mac OS X
      sed -i '' -e "s/^ENV=.*$/ENV=$environment/g" .env.$environment
    else
      # Linux and others
      sed -i'' -e "s/^ENV=.*$/ENV=$environment/g" .env.$environment
    fi
  done
fi

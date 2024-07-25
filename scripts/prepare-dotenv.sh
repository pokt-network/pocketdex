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
      sed -i "s/^ENV=.*$/ENV=$environment/g" .env.$environment
  done
fi

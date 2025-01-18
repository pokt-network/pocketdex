FROM node:18.20.3-slim

ARG CI=false
ARG NODE_ENV=development
ARG ENDPOINT
ARG CHAIN_ID=poktroll
ARG GENESIS_FILENAME

ENV NODE_ENV=$NODE_ENV
ENV ENDPOINT=$ENDPOINT
ENV CHAIN_ID=$CHAIN_ID
ENV CI=$CI
# Required after this version: https://github.com/subquery/subql-cosmos/releases/tag/node-cosmos/4.0.0
ENV TZ=utc

# Set working directory
WORKDIR /app

# Install system dependencies and tools required for the build and runtime
RUN apt-get update && apt-get install -y \
    tree jq postgresql-client tini curl \
    # Required for building the Docker container on ARM64 (e.g., M1 chip).
    make build-essential pkg-config python3 libusb-1.0-0-dev libudev-dev \
    && npm install -g typescript \
    && curl -L https://github.com/mikefarah/yq/releases/download/v4.44.3/yq_linux_amd64 -o /usr/bin/yq && \
    chmod +x /usr/bin/yq && \
    rm -rf /var/lib/apt/lists/*

# Copy the scripts folder, which includes install-vendor.sh
COPY scripts /app/scripts

# Allow execution for every shell script in the `scripts` folder.
RUN chmod +x /app/scripts/*.sh

# ---------------------------------------------------------------------------------------------------------------------
# Vendor
# ---------------------------------------------------------------------------------------------------------------------
# Copy the vendor workspace folder
COPY vendor /app/vendor

RUN /app/scripts/install-vendor.sh

RUN /app/scripts/build-vendor.sh

# we do not need this at this point.
RUN rm -rf /home/app/vendor/subql

# -------------------------------------------
# Dependencies step: Handles main and vendor
# -------------------------------------------
# Copy only dependency-related files to maximize cache and avoid unnecessary rebuilds.
COPY package.json yarn.lock .yarnrc.yml /app/
COPY .yarn /app/.yarn
# Install project dependencies
RUN yarn install

# -------------------------------------------
# Source code step: Separate for better caching
# -------------------------------------------
COPY ./project.ts ./tsconfig.json ./.eslintrc.js ./.eslintignore ./nodemon.json /app/

# src, proto, schema.graphql and genesis.json are mounted to reload code on changes over those files.

ENTRYPOINT ["tini", "--", "/app/scripts/node-entrypoint.sh"]

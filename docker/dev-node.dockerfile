FROM node:18.20.3-slim

ARG CI=false
ARG NODE_ENV=development
ARG ENDPOINT=http://localhost:26657
ARG CHAIN_ID=poktroll

ENV NODE_ENV=$NODE_ENV
ENV ENDPOINT=$ENDPOINT
ENV CHAIN_ID=$CHAIN_ID
ENV CI=$CI
ENV DOCKER_BUILD="true"
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

# -------------------------------------------
# Dependencies step: Handles main and vendor
# -------------------------------------------
# Copy only dependency-related files to maximize cache and avoid unnecessary rebuilds.
COPY package.json yarn.lock .yarnrc.yml vendor-builder.js vendor-config.yaml /app/
COPY .yarn /app/.yarn

# Install project dependencies
RUN yarn install

# ---------------------------------------------------------------------------------------------------------------------
# Vendor
# ---------------------------------------------------------------------------------------------------------------------

# Copy the vendor workspace folder
COPY vendor /app/vendor

# In case yarn run vendors:build fail without an explanation, uncomment below to run install and build and debug it.
#RUN cd /app/vendor/cosmjs && yarn install --inline-builds && yarn build
#RUN cd /app/vendor/subql && yarn install --inline-builds && yarn build
#RUN cd /app/vendor/subql-cosmos && yarn install --inline-builds && yarn build

RUN yarn run vendors:build && \
  # Once they are build we do not really need them there because they are moved to node_modules with packaging.
  rm -rf /app/vendor && \
  apt purge -y make build-essential pkg-config python3 libusb-1.0-0-dev libudev-dev && \
  apt autoremove -y && \
  apt clean && \
  rm -rf /var/lib/apt/lists/* && \
  rm -rf /root/.npm && rm -rf /root/.cache && rm -rf /root/.yarn && \
  rm -rf yarn cache clean && \
  # Cleanup temporary files to reduce layers and space
  rm -rf /tmp/* /var/tmp/*


# -------------------------------------------
# Source code step: Separate for better caching
# -------------------------------------------
COPY ./project.ts ./tsconfig.json ./.eslintrc.js ./.eslintignore ./nodemon.json /app/

# src, proto, schema.graphql and genesis.json are mounted to reload code on changes over those files.

# port of indexer
EXPOSE 3000

ENTRYPOINT ["tini", "--", "/app/scripts/node-entrypoint.sh"]

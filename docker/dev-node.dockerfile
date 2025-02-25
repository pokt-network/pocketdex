FROM node:18.20.3-alpine3.20

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

# Install required system dependencies
RUN apk add --no-cache \
       linux-headers make gcc g++ build-base  \
       python3 py3-pip py3-setuptools libusb-dev eudev-dev pkgconf \
       tree jq postgresql-client tini curl  \
       && npm install -g typescript \
       && curl -L https://github.com/mikefarah/yq/releases/download/v4.44.3/yq_linux_amd64 -o /usr/bin/yq \
       && chmod +x /usr/bin/yq

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

# Run vendors builder
RUN yarn run vendors:build && \
    # Once they are built we do not really need them there because they are moved to node_modules with packaging.
    rm -rf /app/vendor && \
    # Remove vendor build dependencies.
    apk del linux-headers make gcc g++ build-base python3 py3-pip py3-setuptools libusb-dev eudev-dev pkgconf && \
    rm -rf /var/cache/apk/* && \
    rm -rf /root/.npm && rm -rf /root/.cache && rm -rf /root/.yarn && \
    rm -rf yarn cache clean && \
    # Cleanup temporary files to reduce layers and space
    rm -rf /tmp/* /var/tmp/*


# -------------------------------------------
# Source code step: Separate for better caching
# Also this ones on development are mounted to handle hot reload, but needed for slim process.
# -------------------------------------------
COPY ./project.ts ./tsconfig.json ./.eslintrc.js ./.eslintignore ./nodemon.json /app/

# src, proto, schema.graphql and genesis.json are mounted to reload code on changes over those files.

# port of indexer
EXPOSE 3000

ENTRYPOINT ["tini", "--", "/app/scripts/node-entrypoint.sh"]

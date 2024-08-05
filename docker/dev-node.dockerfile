FROM node:22.5-slim

ARG CI=false
ARG NODE_ENV=development
ARG ENDPOINT
ARG CHAIN_ID=poktroll

ENV NODE_ENV=$NODE_ENV
ENV ENDPOINT=$ENDPOINT
ENV CHAIN_ID=$CHAIN_ID
ENV CI=$CI

# typescript is added here because is wrongly used on some of the workspaces, just by the name
# without the use of npm exec, yarn exec or any other to ensure they are looking into the node_modules
RUN apt-get update \
    && apt-get install -y tree git postgresql-client tini curl jq \
    # The following was necessary to install in order to add support for building
    # the docker container on an M1 chip (i.e. ARM64)
    make build-essential pkg-config python3 libusb-1.0-0-dev libudev-dev \
    && npm i -g typescript

# add specific version of yq because depending on the operative system it could get another implementation or version
# than produce error on shell scripts later.
RUN curl -L https://github.com/mikefarah/yq/releases/download/v4.44.3/yq_linux_amd64 -o /usr/bin/yq &&\
            chmod +x /usr/bin/yq

WORKDIR /app

# Copy the minimum required to run install and vendor:setup
# preventing this step need to be re-build everytime due to change on dev files
# but if for X reason you update a vendor package this step CACHE will be dropped
# by docker and fully rebuild
COPY package.json yarn.lock .yarnrc.yml /app/
COPY scripts /app/scripts
COPY .yarn /app/.yarn

# Install dev dependencies
RUN yarn install

# Copy everything because we use nodemon on development to build and watch.
COPY . /app

# Required after this version https://github.com/subquery/subql-cosmos/releases/tag/node-cosmos/4.0.0
ENV TZ=utc

# Allow execution for every shell script at scripts folder
RUN find /app/scripts -type f -name "*.sh" -exec chmod +x {} \;

ENTRYPOINT ["tini", "--", "/app/scripts/node-entrypoint.sh"]

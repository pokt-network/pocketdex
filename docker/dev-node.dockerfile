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
RUN apt-get update && apt-get install -y libusb-1.0-0.dev tree git build-essential pkg-config postgresql-client tini curl jq yq && npm i -g typescript

# Install node-gyp globally
RUN npm install -g node-gyp

WORKDIR /app

# Copy the minimum required to run install and vendor:setup
# preventing this step need to be re-build everytime due to change on dev files
# but if for X reason you update a vendor package this step CACHE will be dropped
# by docker and fully rebuild
COPY package.json yarn.lock .yarnrc.yml /app/
COPY vendor /app/vendor
COPY scripts /app/scripts
COPY .yarn /app/.yarn

# Install dev dependencies
RUN yarn install

## Build forked vendor packages
RUN ./scripts/vendor.sh clean
RUN if [ "$CI" = "true" ]; then ./scripts/vendor.sh clean-cache; else echo "Not in CI"; fi
RUN ./scripts/vendor.sh setup

# Copy everything because we use nodemon on development to build and watch.
COPY . /app

# Allow execution for every shell script at scripts folder
RUN find /app/scripts -type f -name "*.sh" -exec chmod +x {} \;

ENTRYPOINT ["tini", "--", "/app/scripts/node-entrypoint.sh"]

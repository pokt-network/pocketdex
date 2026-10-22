FROM node:26.12.1-alpine3.24@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797

# Build mode: development or production
ARG BUILD_MODE=development
ARG ENDPOINT=http://localhost:26657
ARG CHAIN_ID=poktroll

ENV NODE_ENV=$BUILD_MODE
ENV ENDPOINT=$ENDPOINT
ENV CHAIN_ID=$CHAIN_ID
ENV DOCKER_BUILD="true"
ENV TZ=utc

RUN addgroup -g 1001 app && \
    adduser -D -u 1001 -G app app

WORKDIR /home/app

# System dependencies always required (you can skip dev tools later)
RUN apk add --no-cache \
       linux-headers make gcc g++ build-base  \
       python3 py3-pip py3-setuptools libusb-dev eudev-dev pkgconf \
       tree jq postgresql-client tini curl \
    && npm install -g typescript \
    && curl -L https://github.com/mikefarah/yq/releases/download/v4.44.3/yq_linux_amd64 -o /usr/bin/yq \
    && chmod +x /usr/bin/yq

# The node:26 image ships neither yarn nor corepack; yarn classic hands off to each .yarnrc.yml yarnPath.
ADD --checksum=sha256:c17d3797fb9a9115bf375e31bfd30058cac6bc9c3b8807a3d8cb2094794b51ca https://registry.npmjs.org/yarn/-/yarn-1.22.22.tgz /tmp/yarn-1.22.22.tgz
RUN npm install -g /tmp/yarn-1.22.22.tgz && rm /tmp/yarn-1.22.22.tgz && yarn --version

COPY scripts /home/app/scripts
RUN chmod +x /home/app/scripts/*.sh

# Copy dependency files
COPY package.json yarn.lock .yarnrc.yml vendor-builder.js vendor-config.yaml /home/app/
COPY .yarn /home/app/.yarn

# Install dependencies
# Not a pipe into grep: the pipe's exit status was grep's, so a failed install passed. The log is printed whole on
# failure, and filtered as before on success.
RUN yarn install --immutable --inline-builds --silent > /tmp/yarn-install.log 2>&1 \
      || { cat /tmp/yarn-install.log; exit 1; }; \
    grep -vE "YN000|YN0013|YN0060" /tmp/yarn-install.log || true; \
    rm -f /tmp/yarn-install.log

# Copy vendor workspace
COPY vendor /home/app/vendor

# Build vendor packages
RUN yarn run vendors:build && \
    rm -rf /home/app/vendor && \
    yarn cache clean

# Copy common source files
COPY --chown=app:app ./project.ts ./schema.graphql ./tsconfig.json ./.eslintrc.js ./.eslintignore ./nodemon.json /home/app/
COPY --chown=app:app src /home/app/src
COPY --chown=app:app proto /home/app/proto
# The unit tests read the mainnet fixtures (about 2 MB); the production RUN removes them with src.
COPY --chown=app:app test/money/fixtures /home/app/test/money/fixtures

# For production builds: build, run the unit tests (this is the build CI runs) and prune dev dependencies
RUN if [ "$BUILD_MODE" = "production" ]; then \
      yarn run build && \
      yarn run test:unit && \
      yarn workspaces focus --production && \
      node scripts/check-dist-requires.js && \
      rm -rf /home/app/src /home/app/test; \
    fi

# Remove build dependencies to reduce final image size (for all modes)
RUN apk del linux-headers make gcc g++ build-base python3 py3-pip py3-setuptools libusb-dev eudev-dev pkgconf && \
    rm -rf /var/cache/apk/* /root/.npm /root/.cache /root/.yarn /tmp/* /var/tmp/*

USER app

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--", "/home/app/scripts/node-entrypoint.sh"]

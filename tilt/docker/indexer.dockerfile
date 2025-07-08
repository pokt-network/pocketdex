FROM node:18.20.3-alpine3.20

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

COPY scripts /home/app/scripts
RUN chmod +x /home/app/scripts/*.sh

# Copy dependency files
COPY package.json yarn.lock .yarnrc.yml vendor-builder.js vendor-config.yaml /home/app/
COPY .yarn /home/app/.yarn

# Install dependencies
RUN yarn install --immutable --inline-builds --silent 2>&1 | grep -vE "YN000|YN0013|YN0060"

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

# For production builds: build and prune dev dependencies
RUN if [ "$BUILD_MODE" = "production" ]; then \
      yarn run build && \
      yarn workspaces focus --production && \
      rm -rf /home/app/src; \
    fi

# Remove build dependencies to reduce final image size (for all modes)
RUN apk del linux-headers make gcc g++ build-base python3 py3-pip py3-setuptools libusb-dev eudev-dev pkgconf && \
    rm -rf /var/cache/apk/* /root/.npm /root/.cache /root/.yarn /tmp/* /var/tmp/*

USER app

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--", "/home/app/scripts/node-entrypoint.sh"]

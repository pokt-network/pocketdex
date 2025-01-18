# Use the Node.js base image
FROM node:18.20.3-slim

# Set arguments and environment variables
ARG GENESIS_FILENAME=testnet.json
ARG NODE_ENV=production
ARG ENDPOINT
ARG CHAIN_ID=poktroll

ENV NODE_ENV=$NODE_ENV
ENV ENDPOINT=$ENDPOINT
ENV CHAIN_ID=$CHAIN_ID
ENV TZ=utc

# Create and set up a non-root user for security
RUN addgroup --gid 1001 app && \
    useradd --create-home --uid 1001 --gid app app

# Set working directory
WORKDIR /home/app

# Install system dependencies and tools required for the build and runtime
RUN apt-get update && apt-get install -y \
    tree jq postgresql-client tini curl \
    # Required for building the Docker container on ARM64 (e.g., M1 chip).
    make build-essential pkg-config python3 libusb-1.0-0-dev libudev-dev \
    && npm install -g typescript \
    && curl -L https://github.com/mikefarah/yq/releases/download/v4.44.3/yq_linux_amd64 -o /usr/bin/yq && \
    chmod +x /usr/bin/yq && \
    rm -rf /var/lib/apt/lists/*

# TODO: split this to first copy everything to run the vendor things event the build, then the other things.
# Copy the entire project into the Docker image
COPY . /home/app

# Install dependencies, build vendor packages, and the application
RUN chmod +x /home/app/scripts/*.sh

RUN /home/app/scripts/install-vendor.sh

RUN /home/app/scripts/build-vendor.sh

RUN yarn install

RUN yarn run build

# Allow execution for every shell script in the `scripts` folder
RUN find /home/app/scripts -type f -name "*.sh" -exec chmod +x {} \;

# Switch to the non-root user created earlier
USER app

# Use `tini` as the entrypoint for better process handling
ENTRYPOINT ["/usr/bin/tini", "--", "/home/app/scripts/node-entrypoint.sh"]

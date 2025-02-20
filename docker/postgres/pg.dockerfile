FROM postgres:16-alpine

# Variables needed at runtime to configure postgres and run the initdb scripts
ENV POSTGRES_DB 'postgres'
ENV POSTGRES_USER 'postgres'
ENV POSTGRES_PASSWORD 'postgres'

RUN apk add --no-cache --virtual .build-deps \
    git \
    build-base \
    postgresql-dev \
    clang \
    llvm-dev \
    curl

# Clone, build, and install system_stats extension
RUN git clone https://github.com/EnterpriseDB/system_stats.git /tmp/system_stats && \
    cd /tmp/system_stats && \
    PATH="/usr/local/pgsql/bin:$PATH" make USE_PGXS=1 && \
    PATH="/usr/local/pgsql/bin:$PATH" make install USE_PGXS=1 && \
    cd .. && rm -rf /tmp/system_stats

# Copy in the load-extensions script
COPY docker/postgres/load-extensions.sh /docker-entrypoint-initdb.d/

# Convert line endings to LF
RUN sed -i 's/\r$//' /docker-entrypoint-initdb.d/load-extensions.sh && chmod +x /docker-entrypoint-initdb.d/load-extensions.sh

COPY docker/postgres/postgresql.conf /etc/postgresql/postgresql.conf

# Copy custom PostgreSQL configuration
COPY docker/postgres/postgresql.conf /etc/postgresql/postgresql.conf

# Instruct PostgreSQL to use the custom configuration
CMD ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf"]

# Prototype only. BASE_IMAGE must be an already-seeded digest-pinned image.
# Its Node 24 and pnpm 10.28.0 installation is a reviewed prerequisite.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
WORKDIR /opt/reviewed-monorepo
COPY workspace/ ./
COPY pnpm-store/ /opt/reviewed-pnpm-store/
COPY npm-cache/ /opt/reviewed-npm-cache/
COPY prisma/ /opt/reviewed-prisma/
RUN --network=none test "$(node -p 'process.versions.node.split(".")[0]')" = 24 \
    && test "$(pnpm --version)" = 10.28.0 \
    && cd /opt/reviewed-prisma \
    && test "$(wc -l < SHA256SUMS)" -eq 2 \
    && grep -Eq '^[[:xdigit:]]{64} [ *]schema-engine$' SHA256SUMS \
    && grep -Eq '^[[:xdigit:]]{64} [ *]libquery_engine\.so\.node$' SHA256SUMS \
    && sha256sum -c SHA256SUMS \
    && test -x schema-engine && test -r libquery_engine.so.node \
    && cd /opt/reviewed-monorepo \
    && pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir /opt/reviewed-pnpm-store
ENV PRISMA_SCHEMA_ENGINE_BINARY=/opt/reviewed-prisma/schema-engine \
    PRISMA_QUERY_ENGINE_LIBRARY=/opt/reviewed-prisma/libquery_engine.so.node
USER 65534:65534
WORKDIR /work

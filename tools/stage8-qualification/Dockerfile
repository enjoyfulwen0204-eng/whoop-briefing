# Official immutable image identities; no historical test image or Git objects.
# Node identity: docker-library/repo-info, 22.23.3-bookworm, linux/amd64.
# sqld identity: tursodatabase/libsql package, retained f8fb14f multiarch index.
FROM ghcr.io/tursodatabase/libsql-server@sha256:bc100873a74865392a49191b4733025fe8222a409799efa424dc196feaf05035 AS sqld
FROM node@sha256:c4d5523090a817b7aa86d2111241fdd4f66d1e27782b44160e6aa63b357ecb2d
COPY --from=sqld /bin/sqld /usr/local/bin/isolated-sqld
ARG QUALIFICATION_ROOT
ARG QUALIFICATION_UID
ARG QUALIFICATION_GID
WORKDIR ${QUALIFICATION_ROOT}
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && test "$(node --version)" = v22.23.3 \
    && isolated-sqld --version > /tmp/sqld-version \
    && grep -Eq '^sqld 0[.]24[.]33($| )' /tmp/sqld-version \
    && command -v git && command -v timeout \
    && chown "${QUALIFICATION_UID}:${QUALIFICATION_GID}" "${QUALIFICATION_ROOT}" \
    && rm /tmp/sqld-version
# The trusted runner replaces this command explicitly. No application starts.
CMD ["/bin/false"]

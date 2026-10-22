# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    STRAPI_TELEMETRY_DISABLED=true

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

COPY . .
RUN npm run build \
    && npm prune --omit=dev --ignore-scripts \
    && rm -rf /root/.npm .cache .tmp

FROM ${NODE_IMAGE} AS runtime
LABEL io.gthf.media-recovery="2"
LABEL io.gthf.media-batch-recovery="1"
WORKDIR /app
ARG GTHDF_REVISION=development
ARG GTHF_REVISION=${GTHDF_REVISION}
ENV GTHF_REVISION=${GTHF_REVISION}
LABEL org.opencontainers.image.revision=${GTHF_REVISION}
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=1337 \
    STRAPI_TELEMETRY_DISABLED=true

RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx

COPY --from=build --chown=node:node /app /app

USER node
EXPOSE 1337
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:1337/_health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "node_modules/@strapi/strapi/bin/strapi.js", "start"]

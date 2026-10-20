# The web server only. The heavy tools (RFdiffusion, ProteinMPNN, RF2,
# DiscoTope, ...) live in the separate tools image (docker/Dockerfile, published
# as rachmatthirdi/igem_brawijaya); this server starts that image per request
# through the host's Docker socket.

FROM docker:27.5.1-cli AS dockercli

FROM node:24.12.0-bookworm-slim
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server ./server
COPY renderer ./renderer
COPY python ./python
COPY scripts/prewarm.js ./scripts/prewarm.js

ENV NODE_ENV=production PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Runs as root on purpose: it must reach /var/run/docker.sock. Everything a
# user can influence is validated in server/validate.js before it gets here.
CMD ["node", "server/index.js"]

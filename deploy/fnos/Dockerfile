FROM node:22.23.5-bookworm
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY backend/src ./src
COPY backend/public ./public
COPY shared /app/shared
COPY scripts/migrate-legacy-backend* /app/scripts/
COPY --chmod=0755 deploy/fnos/bin/tie-cli /usr/local/bin/tie-cli
ENV NODE_ENV=production TIE_BIND=0.0.0.0 PORT=8787 TIE_DATA_DIR=/data
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]

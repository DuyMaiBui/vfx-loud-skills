FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY server ./server
COPY seed ./seed
COPY scripts ./scripts

ENV PORT=8787 DATA_DIR=/data
EXPOSE 8787

CMD ["node", "server/src/index.ts"]

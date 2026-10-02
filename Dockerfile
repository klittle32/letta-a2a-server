FROM node:24.19.0-bookworm
RUN npm install --global bun@1.4.2
WORKDIR /app
RUN mkdir -p /app/node_modules /home/node/.letta /home/node/.cache \
    && chown -R node:node /app /home/node
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 npm ci
COPY --chown=node:node tsconfig.json tsconfig.build.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node tests ./tests
COPY --chown=node:node scripts ./scripts
RUN npm run check && npm run build
CMD ["node", "dist/main.js"]

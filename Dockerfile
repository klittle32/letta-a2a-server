FROM node:24.19.0-bookworm
RUN npm install --global bun@1.4.2
WORKDIR /app
RUN mkdir -p /app/node_modules /home/node/.letta /home/node/.cache \
    && chown -R node:node /app /home/node
USER node
CMD ["npm", "run", "dev"]

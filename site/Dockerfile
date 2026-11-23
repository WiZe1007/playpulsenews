FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node worker/runtime.mjs ./worker/runtime.mjs
COPY --chown=node:node dist ./dist
RUN mkdir -p /var/data/play-pulse && chown node:node /var/data/play-pulse
USER node
ENV PORT=10000
EXPOSE 10000
CMD ["node", "server/start.mjs"]

FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node bot.mjs setup.mjs doctor.mjs pair.mjs delivery.mjs notifications.mjs presentation.mjs migration.mjs package.json ./
COPY --chown=node:node assets ./assets
RUN mkdir -p /app/.runtime /home/node/.ssh \
    && chown node:node /app/.runtime /home/node/.ssh \
    && chmod 0700 /app/.runtime /home/node/.ssh
VOLUME ["/app/.runtime"]
USER node
CMD ["node", "bot.mjs"]

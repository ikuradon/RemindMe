FROM denoland/deno:2.0.2

WORKDIR /app
COPY --chown=deno . .
RUN deno cache src/bot.ts

CMD ["task", "start"]

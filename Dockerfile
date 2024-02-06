FROM denoland/deno:1.40.3

WORKDIR /app
COPY --chown=deno . .
RUN deno cache src/bot.ts

EXPOSE 3000
CMD ["task", "start"]

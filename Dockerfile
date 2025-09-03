FROM node:20-slim

WORKDIR /app
COPY index.js ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]

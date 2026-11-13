FROM node:22-alpine

WORKDIR /app
COPY . .
RUN mkdir -p data

ENV HOST=0.0.0.0 \
    PORT=8787 \
    NODE_ENV=production \
    DB_FILE=data/pickleball.db

EXPOSE 8787
VOLUME ["/app/data"]

CMD ["node", "backend/src/index.js"]

FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY examples ./examples
COPY web ./web
COPY jarvis-robot-640x360.jpg ./
USER node
EXPOSE 8080
CMD ["node","src/serve.ts"]

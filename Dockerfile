FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "src/index.js"]

FROM node:16-alpine

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

RUN chown -R node:node /usr/src/app

USER node

EXPOSE 9080
EXPOSE 9110

CMD [ "node", "server.js" ]

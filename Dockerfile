FROM node:18.20.3

WORKDIR /usr/src/app

COPY package*.json ./

RUN apt-get -y update
RUN apt-get -y upgrade
RUN apt-get install -y ffmpeg

RUN npm install

COPY . .

CMD ["node", "index.js"]
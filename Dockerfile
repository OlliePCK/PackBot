FROM node:22.13.1

WORKDIR /usr/src/app

COPY package*.json ./

RUN apt-get -y update
RUN apt-get -y upgrade
RUN apt-get install -y ffmpeg python3 python3-pip

# Install yt-dlp via pip (installs to /usr/local/bin/yt-dlp)
RUN pip3 install --break-system-packages yt-dlp

RUN npm install

COPY . .

# Set environment variable for yt-dlp path
ENV YTDLP_PATH=/usr/local/bin/yt-dlp

# Logger configuration
ENV LOG_LEVEL=info
ENV LOG_FORMAT=text
ENV LOG_COLORS=false
ENV LOG_DIR=logs
ENV LOG_MAX_SIZE_MB=5
ENV LOG_MAX_FILES=5

# Voice commands use Deepgram API (set DEEPGRAM_API_KEY in environment)

# Web API port
ENV API_PORT=3001
EXPOSE 3001

CMD ["node", "index.js"]
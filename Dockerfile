FROM node:22.13.1

WORKDIR /usr/src/app

COPY package*.json ./

RUN apt-get update -y \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    libnspr4 \
    libnss3 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxshmfence1 \
    libasound2 \
    libxss1 \
    fonts-liberation \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

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

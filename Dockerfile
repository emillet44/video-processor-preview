# Use Node.js base image
FROM node:20-slim

# Install ffmpeg and fontconfig
RUN apt-get update && apt-get install -y \
  ffmpeg \
  fontconfig \
  fonts-noto-cjk \
  fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

# Create the directory for custom fonts
RUN mkdir -p /usr/share/fonts/truetype/custom

# Copy BOTH fonts from your repo into the container
COPY font.ttf /usr/share/fonts/truetype/custom/font.ttf

# Rebuild font cache
RUN fc-cache -f -v

# Create app directory
WORKDIR /usr/src/app

# Copy source files
COPY package.json index.js ./

# Install dependencies
RUN npm install --production

# Start the server
CMD ["npx", "@google-cloud/functions-framework", "--target=processVideos"]

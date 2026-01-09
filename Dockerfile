# Use Node.js base image
FROM node:20-slim

# Install ffmpeg and fontconfig
RUN apt-get update && apt-get install -y \
  ffmpeg \
  fontconfig \
  && rm -rf /var/lib/apt/lists/*

# Add your custom font (assumes it's named myfont.ttf)
COPY font.ttf /usr/share/fonts/truetype/font.ttf

# Rebuild font cache so ffmpeg can detect it
RUN fc-cache -f -v

# Create app directory
WORKDIR /usr/src/app

# Copy source files
COPY package.json index.js ./

# Install dependencies
RUN npm install --production

# Start the server
CMD ["npx", "@google-cloud/functions-framework", "--target=processVideos"]

# Use an official Node.js runtime as a parent image. This includes Python.
FROM node:18-bullseye

# Install system dependencies required by stable-ts and its dependencies.
# git is needed for pip to install from GitHub.
# ffmpeg is required by openai-whisper.
RUN apt-get update && apt-get install -y \
    git \
    ffmpeg \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory in the container.
WORKDIR /app

# Copy Python requirements file and install dependencies first to leverage Docker caching.
COPY requirements.txt ./
RUN pip3 install -r requirements.txt

# Copy package.json and install Node.js dependencies.
# If you have a package-lock.json, you should copy it here as well.
COPY package.json ./
RUN npm install

# Now that dependencies are installed, copy the rest of the application source code.
COPY . .

# Build the TypeScript code into JavaScript.
RUN npm run build

# Your app listens on port 3001, but Render will map its internal port.
# The PORT environment variable will be set by Render automatically.
EXPOSE 3001

# The command to run the application.
# We use the compiled JavaScript in the 'dist' directory.
CMD ["node", "dist/index.js"]

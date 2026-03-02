FROM node:20

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .
# Normalize line endings (CRLF -> LF) so shebang works on all platforms (fixes "Exec format error" on Railway)
RUN sed -i 's/\r$//' entrypoint.sh && chmod +x entrypoint.sh

EXPOSE 3000

# Run via sh explicitly so the script is not executed as a binary (avoids Exec format error)
ENTRYPOINT ["/bin/sh", "/usr/src/app/entrypoint.sh"]
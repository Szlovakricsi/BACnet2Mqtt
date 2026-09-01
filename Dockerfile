FROM ghcr.io/home-assistant/base:latest

ARG BUILD_VERSION
ARG BUILD_ARCH

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}"

RUN apk add --no-cache nodejs npm

WORKDIR /app

COPY package.json /app/package.json
RUN npm install --omit=dev --no-audit --no-fund

COPY src /app/src
COPY frontend /app/frontend
COPY web /app/web
COPY icon.png /app/web/icon.png
COPY run.sh /run.sh

RUN chmod a+x /run.sh

CMD ["/run.sh"]

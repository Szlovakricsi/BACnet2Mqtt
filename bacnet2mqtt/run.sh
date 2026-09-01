#!/usr/bin/with-contenv bashio
set -e

bashio::log.info "Starting BACnet2MQTT..."
exec node /app/src/index.js

# BACnet2MQTT

Home Assistant App repository for **BACnet2MQTT v0.3.3**.

## Features

- BACnet/IP → MQTT gateway
- Home Assistant MQTT Discovery
- BACnet device discovery
- COV subscriptions + polling fallback
- writable BACnet points with priority handling
- BACnet Schedule support
- BACnet Schedule Lovelace card
- Ingress device/datapoint manager
- device/datapoint rename
- analog min / max / step overrides
- Schedule ON/OFF text, raw value type, unit and range configuration
- Home Assistant-native reboot/update entity

## Install

Add this repository to the Home Assistant App Store:

```text
https://github.com/Szlovakricsi/BACnet2Mqtt
```

Then install **BACnet2MQTT**.

Configure at minimum:

- MQTT broker address
- BACnet local interface address
- BACnet broadcast address

## Repository layout

```text
BACnet2Mqtt/
├── repository.yaml
├── README.md
└── bacnet2mqtt/
    ├── config.yaml
    ├── Dockerfile
    ├── run.sh
    ├── README.md
    ├── DOCS.md
    ├── CHANGELOG.md
    ├── icon.png
    ├── package.json
    ├── src/
    ├── frontend/
    ├── web/
    └── translations/
```

## Versions

- BACnet2MQTT App: **0.3.3**
- BACnet Schedule Card: **0.3.3**

## Development

When releasing a new version, keep these App versions synchronized:

- `bacnet2mqtt/config.yaml`
- `bacnet2mqtt/package.json`
- `bacnet2mqtt/src/constants.js`

The repository descriptor must remain at the repository root:

```text
repository.yaml
```

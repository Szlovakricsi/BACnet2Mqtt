# BACnet2MQTT

##THIS IS A BETA

Home Assistant App repository for **BACnet2MQTT v0.4.3**.

BACnet2MQTT is a bidirectional BACnet/IP and Home Assistant gateway. It discovers BACnet controllers and publishes their data points through MQTT Discovery, and it can also expose selected Home Assistant entities back to BACnet as a virtual BACnet device.

## Features

- BACnet/IP → MQTT / Home Assistant
- Home Assistant → BACnet virtual device export
- Home Assistant MQTT Discovery
- BACnet Who-Is / I-Am discovery
- COV subscriptions with polling fallback
- writable BACnet points with priority handling and Priority Release
- BACnet Schedule read/write support and bundled Lovelace card
- Ingress device/datapoint manager
- persistent device/datapoint presentation overrides
- device/datapoint rename
- analog min / max / step overrides
- Schedule ON/OFF text, raw value type, unit and range configuration
- automatic datapoint settings save when the editor is closed
- orange/yellow pulsing Save button while datapoint settings contain unsaved changes
- virtual Home Assistant BACnet Device with Analog Value, Binary Value and CharacterString Value exports
- MQTT Discovery gateway device named **BACnet Driver**

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

The BACnet listener binds to `0.0.0.0:<bacnet_port>` so subnet broadcast Who-Is requests can be received. The configured BACnet interface and broadcast address are retained for network configuration and outgoing BACnet traffic.

## MQTT Driver device

BACnet2MQTT publishes its gateway controls and diagnostics as a Home Assistant MQTT Discovery device named:

```text
BACnet Driver
```

Its topics remain under the stable `bacnet2mqtt/driver/...` namespace for compatibility.

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

- BACnet2MQTT App: **0.4.3**
- BACnet Schedule Card: **0.3.3**

## Development

When releasing a new App version, keep these versions synchronized:

- `bacnet2mqtt/config.yaml`
- `bacnet2mqtt/package.json`
- `bacnet2mqtt/src/constants.js`
- Web UI cache-busting/version labels where applicable

The repository descriptor must remain at the repository root:

```text
repository.yaml
```

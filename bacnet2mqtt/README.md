# BACnet2MQTT

BACnet2MQTT v0.4.3 is a bidirectional BACnet/IP and Home Assistant gateway.

It discovers BACnet devices and supported points, publishes Home Assistant MQTT Discovery entities, performs reads and writes, manages BACnet write priority and Priority Release, tracks availability, supports BACnet Schedules, and can expose selected Home Assistant entities back to BACnet through a virtual BACnet Device.

See `DOCS.md` for configuration, Web UI and troubleshooting details.

## MQTT Discovery driver device

Gateway controls and diagnostics are grouped under the Home Assistant MQTT Discovery device:

```text
BACnet Driver
```

The MQTT topic namespace remains `bacnet2mqtt/driver/...` for compatibility.

## Ingress device and datapoint manager

Open **BACnet2MQTT** from the Home Assistant sidebar.

The Ingress UI lets you:

- discover and inspect BACnet devices
- see live values and online/offline state
- control writable BACnet points
- rename devices and datapoints for Home Assistant presentation
- override analog min/max/step values
- configure BACnet Schedule display/write profiles
- edit Weekly_Schedule directly
- expose Home Assistant entities back to BACnet from the **HA → BACnet** workspace

Datapoint settings now track unsaved edits. As soon as a field is changed, the **Save** button pulses orange/yellow until the configuration is saved. Closing the datapoint settings panel automatically saves pending changes first. If the save fails, the panel stays open and the unsaved indication remains visible.

Device and point overrides are stored persistently and are applied to Home Assistant MQTT Discovery. Deleting a device from this UI only removes it from BACnet2MQTT; it never deletes the physical BACnet controller.

## Home Assistant → BACnet

Selected Home Assistant entities can be exported as a virtual BACnet/IP device. Supported export object types currently include:

- Analog Value
- Binary Value
- CharacterString Value

Writable Home Assistant domains can also be controlled from BACnet through supported Home Assistant service calls.

The virtual device shares the gateway's BACnet/IP socket instead of opening a second UDP/47808 listener.

## BACnet discovery networking

The BACnet client listens on:

```text
0.0.0.0:<bacnet_port>
```

This allows subnet broadcast Who-Is packets from other machines (for example YABE) to reach the App. The configured `bacnet_broadcast` address is still used for outgoing BACnet broadcast traffic.

## Bundled Schedule Card

BACnet Schedule Card is installed automatically by the App. No manual `/config/www` copy or Dashboard Resource entry is required.

The bundled Schedule Card version remains v0.3.3 in this App release.

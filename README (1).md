# BACnet2MQTT

BACnet/IP → MQTT gateway for Home Assistant. v0.3.3

This is the first experimental local Home Assistant App build based on the tested Node-RED gateway logic. It discovers BACnet devices and supported points, publishes Home Assistant MQTT Discovery entities, performs reads and writes, manages BACnet write priority and Priority Release, tracks availability, and attempts COV subscriptions.

See `DOCS.md` for installation and first-test instructions.


## Bundled Schedule Card

BACnet Schedule Card is installed automatically by the App. No manual
`/config/www` copy or Dashboard Resource entry is required.

After the App is updated, Home Assistant will show a persistent notification
asking for a restart/hard refresh when the frontend card version changed.
\n\n## Ingress Device Manager\n\nOpen **BACnet2MQTT** from the Home Assistant sidebar. The v0.3.0 Ingress UI lets\nyou select devices, see online/offline state, inspect live point values, control\nwritable points, rename devices/points and override analog min/max/step values.\n\nDevice and point overrides are stored persistently and are applied to Home\nAssistant MQTT Discovery. Deleting a device from this UI only removes it from\nBACnet2MQTT; it never deletes the physical BACnet controller.\n

## Modern Ingress device manager

v0.3.1 refreshes the built-in device/point manager and adds an interactive
`Home Assistant reboot required` flow after updates. Use `Submit` in the dialog
to restart Home Assistant Core; `Later` keeps a reminder badge in the header.


## v0.3.3 Schedule workspace

Schedule objects can now be edited directly in the Ingress UI. Each Schedule has its own display/write profile (binary, named states, or numeric), BACnet application value type, labels/raw values, unit, range and step. The bundled Lovelace Schedule Card reads the same profile automatically.

When the bundled frontend resource changes, BACnet2MQTT exposes a native Home Assistant MQTT Update entity called **Home Assistant Reboot Required** on the Driver device. Use the normal Home Assistant Update dialog and press **Update** to restart Home Assistant Core.

# BACnet2MQTT Home Assistant App

BACnet2MQTT v0.4.3 is a bidirectional BACnet/IP and Home Assistant gateway.

It supports two directions:

1. **BACnet → Home Assistant** — BACnet controllers and data points are discovered, read and published through MQTT Discovery.
2. **Home Assistant → BACnet** — selected Home Assistant entities are exposed as objects of a virtual BACnet/IP Device.

The App uses Home Assistant Ingress for its Web UI and host networking for BACnet/IP broadcast discovery.

## Implemented BACnet → Home Assistant features

- BACnet/IP Who-Is / I-Am device discovery
- Device metadata readout
- indexed `Object_List` discovery
- AI, AO, AV, BI, BO, BV, MSI, MSO, MSV and Schedule support
- writable detection using BACnet commandability metadata
- read-only analog values → Home Assistant sensor
- writable analog values → Home Assistant number
- read-only binary values → Home Assistant binary_sensor
- writable binary values → Home Assistant switch
- read-only multi-state values → Home Assistant sensor
- writable multi-state values → Home Assistant select
- configurable BACnet write priority 1–16
- Priority Release using BACnet NULL
- write verification and readback
- COV subscriptions with periodic polling fallback
- per-device availability and health checking
- persistent BACnet device/point cache
- persistent Web UI presentation overrides
- BACnet Schedule reading/writing
- bundled BACnet Schedule Lovelace card

## Implemented Home Assistant → BACnet features

The **HA → BACnet** workspace can expose selected Home Assistant entities on one virtual BACnet Device.

Supported BACnet export object types:

- Analog Value
- Binary Value
- CharacterString Value

The App reads Home Assistant entity states through the Supervisor/Home Assistant API. For supported writable domains, BACnet `WriteProperty` requests are translated back into Home Assistant service calls.

The virtual BACnet Device shares the same BACnet/IP client/socket as the normal BACnet gateway. It does not open a second UDP/47808 listener.

## Installation

1. Add the repository to the Home Assistant App Store:

```text
https://github.com/Szlovakricsi/BACnet2Mqtt
```

2. Install **BACnet2MQTT**.
3. Configure the MQTT and BACnet/IP settings.
4. Start the App.
5. Open the App log and then the Ingress Web UI.

## Required configuration

At minimum configure:

```yaml
mqtt_host: "192.168.x.x"
bacnet_interface: "192.168.x.x"
bacnet_broadcast: "192.168.x.255"
```

The remaining common settings include:

```yaml
mqtt_port: 1883
bacnet_port: 47808
apdu_timeout: 6000
write_priority: 16
scan_timeout: 5
health_interval: 10
poll_interval: 60
read_concurrency: 8
cov_enabled: true
cov_lifetime: 300
cov_renew_percent: 80
cov_subscribe_delay_ms: 30
log_level: info
```

## BACnet/IP listener and broadcast discovery

BACnet2MQTT deliberately binds the UDP BACnet listener to:

```text
0.0.0.0:<bacnet_port>
```

The `@bacnet-js/client` transport binds directly to its configured interface address. Binding only to one host address can prevent Linux from delivering subnet broadcast packets addressed to e.g. `192.168.10.255:47808` to that socket. Listening on `0.0.0.0` allows Who-Is broadcast traffic from other BACnet tools and controllers to be received.

The configured `bacnet_broadcast` value is retained for outgoing BACnet broadcast traffic, and normal OS routing selects the proper interface for unicast traffic.

A useful YABE test is:

1. start BACnet2MQTT,
2. enable the virtual HA BACnet Device,
3. run a normal YABE Who-Is from another machine on the same subnet,
4. check the BACnet2MQTT log for a line similar to:

```text
HA→BACnet Who-Is from 192.168.x.x:47808; responding as Device 3900000
```

If direct IP + Device Instance access works but Who-Is does not, first verify the subnet broadcast address, VLAN/firewall broadcast handling and UDP/47808.

## MQTT Discovery

BACnet2MQTT publishes gateway controls and diagnostics under a Home Assistant MQTT Discovery device named:

```text
BACnet Driver
```

The stable MQTT topic namespace remains:

```text
bacnet2mqtt/driver/...
```

Important driver topics:

```text
bacnet2mqtt/driver/status
bacnet2mqtt/control/scan
bacnet2mqtt/control/read
bacnet2mqtt/control/homeassistant-restart
```

Device availability:

```text
bacnet2mqtt/<deviceId>/availability
```

Point state and command:

```text
bacnet2mqtt/<deviceId>/<objectType>/<instance>/state
bacnet2mqtt/<deviceId>/<objectType>/<instance>/set
```

Point entities require both the **BACnet Driver** and their physical BACnet device to be available.

## Ingress Web UI

Open **BACnet2MQTT** from the Home Assistant sidebar.

The device workspace provides:

- discovered BACnet device list
- online/offline indicators
- device metadata
- live data point values
- object type and instance
- direct controls for writable points
- Priority Release
- device display-name overrides
- point display-name overrides
- analog min/max/step overrides
- Schedule profile configuration
- Schedule weekly editor
- deleted-device restore list
- Scan BACnet and Read controls

Overrides are stored in:

```text
/data/ui-settings.json
```

These overrides affect BACnet2MQTT/Home Assistant presentation and do not rewrite physical BACnet metadata such as `Object_Name`, `Min_Pres_Value`, `Max_Pres_Value` or `Resolution`.

## Datapoint settings save behavior

Starting with v0.4.3, point settings have an explicit unsaved state.

When any field inside a point's settings panel changes:

- the **Save** button starts pulsing between orange and yellow,
- the pulsing continues until the settings are successfully saved,
- pressing **Save** performs the normal point configuration `PUT`,
- closing the point settings panel with pending changes automatically saves first,
- the panel closes only after a successful automatic save,
- if saving fails, the panel remains open and the pulsing unsaved state remains visible.

This applies to ordinary point presentation settings and Schedule presentation/write settings shown in the point settings area.

## Device and point rename behavior

Device and point rename operations are display overrides only.

For example, renaming a point in BACnet2MQTT changes its Home Assistant/MQTT Discovery display name but does not write the physical BACnet object's `Object_Name` property.

## Writable analog points

BACnet REAL values are float32 values and can decode with binary floating-point noise. BACnet2MQTT normalizes min/max/resolution and writable analog states to useful decimal precision before publishing Home Assistant Number discovery.

Priority writes use the configured `write_priority`. Priority Release writes BACnet NULL to the same priority slot.

## Multi-State points

Multi-State labels are read from BACnet `State_Text` when available. Writable Home Assistant select entities translate selected labels back to the appropriate BACnet state number.

`AUTO` is treated as an ordinary state when the physical controller defines it as such. Priority Release is separate from Multi-State values.

## BACnet Schedule support

BACnet Object Type 17 is supported. Schedule data includes, when available:

- Present_Value
- Schedule_Default
- Priority_For_Writing
- Effective_Period
- Weekly_Schedule
- Exception_Schedule
- List_Of_Object_Property_References

The Ingress Schedule editor can write a complete Weekly_Schedule directly through BACnet and is not limited by Home Assistant MQTT Text's 255-character state limit.

Supported Schedule presentation modes:

- Binary ON/OFF
- Named states
- Numeric

Supported BACnet write value types:

- Auto
- Enumerated
- Boolean
- REAL
- Unsigned integer
- Signed integer

## Home Assistant → BACnet configuration

Open **HA → BACnet** from the BACnet2MQTT Web UI.

The virtual device has configurable fields such as:

```text
Device name: Home Assistant
Device ID: 3900000
Polling interval: 2 s
```

Example exports:

```text
sensor.living_room_temperature
→ Analog Value 1
→ read only

binary_sensor.motion
→ Binary Value 1
→ read only

switch.pump
→ Binary Value 2
→ writable

input_number.setpoint
→ Analog Value 2
→ writable
```

Configuration is persisted in:

```text
/data/ha-bacnet-export.json
```

## Supported Home Assistant write mappings

The current bridge supports common write operations including:

- `switch`, `input_boolean`, `light`, `fan` → ON/OFF
- `cover` → open/close
- `lock` → lock/unlock
- `number`, `input_number` → set_value
- `select`, `input_select` → select_option
- `text`, `input_text` → set_value
- `climate` CharacterString export → set_hvac_mode

Unsupported entity/domain/type combinations remain read-only.

## Expected startup log

A healthy startup should contain lines similar to:

```text
[MQTT] connected to mqtt://...
BACnet/IP listening on 0.0.0.0:47808, broadcast ...
Starting BACnet scan (...s)...
BACnet scan found N devices
Device ...: discovering ... supported points
Published Home Assistant discovery (... active entities)
HA→BACnet virtual device enabled: Device 3900000, ... mapped entities
```

Exact wording may vary by log level and configuration.

## Troubleshooting

If BACnet discovery fails, collect the startup log from the first MQTT connection line through the BACnet scan. Use `log_level: debug` when additional detail is required.

Check these items first:

- correct `bacnet_broadcast` for the BACnet subnet
- UDP/47808 allowed between hosts
- BACnet client and controller are on the expected VLAN/subnet
- no second BACnet2MQTT/Node-RED gateway is competing on the same host/port
- virtual BACnet Device ID is unique on the BACnet network
- YABE is bound to the correct local NIC

If direct BACnet unicast reads work but Who-Is discovery does not, focus on broadcast delivery/firewall/VLAN behavior rather than ReadProperty handling.

## Persistent files

BACnet2MQTT stores runtime state under `/data`, including:

```text
/data/cache.json
/data/ui-settings.json
/data/ha-bacnet-export.json
/data/homeassistant-restart-required.json
```

These files survive App restarts and upgrades according to normal Home Assistant App data persistence behavior.

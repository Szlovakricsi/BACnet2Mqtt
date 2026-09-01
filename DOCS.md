# BACnet2MQTT Home Assistant App

This is an experimental first test version of the standalone BACnet2MQTT gateway. Disable the Node-RED BACnet2MQTT flow while testing this App so that two gateways do not publish the same Home Assistant MQTT Discovery topics or issue competing BACnet writes.

## Implemented

- BACnet/IP Who-Is / I-Am device discovery
- Device metadata readout
- Object_List based point discovery
- AI, AO, AV, BI, BO, BV, MSI, MSO and MSV support
- Writable detection by reading `Relinquish_Default`
- Read-only AV/AO -> sensor
- Writable AV/AO -> number
- Read-only BV/BO -> binary_sensor
- Writable BV/BO -> switch
- Read-only MSV/MSO -> sensor
- Writable MSV/MSO -> select
- Priority Release button only for writable points
- Configurable BACnet write priority 1-16
- `RELEASE` sends BACnet NULL at the configured priority
- 500 ms write readback with retries
- Home Assistant MQTT Discovery
- Separate Home Assistant `Driver` device
- Driver Status, BACnet Scan and BACnet Read entities
- MQTT Last Will / online status
- Per-device online/offline availability
- Point entities require BOTH Driver online and BACnet device online
- Device health checking
- Periodic full fallback poll
- Offline -> online automatic point rediscovery
- COV subscribe / renew attempt
- Persistent device/point/discovery cache in `/data/cache.json`

## Installation as a local Home Assistant App

1. Extract the archive.
2. Copy the complete `bacnet2mqtt` folder to the Home Assistant local Apps/add-ons directory, normally `/addons/bacnet2mqtt`.
3. Reload the local App store / Apps list in Home Assistant.
4. Install **BACnet2MQTT**.
5. Open the App Configuration page and verify the MQTT and BACnet/IP network settings.
6. Start the App.
7. Open the App log.

The App uses host networking because BACnet/IP discovery depends on UDP broadcast traffic.

## Expected first startup

A successful first startup should progress approximately like this:

```text
[MQTT] connected to mqtt://...
BACnet/IP listening on ...
Starting BACnet scan (...s)...
BACnet scan found N devices
Device ...: discovering ... supported points
Published Home Assistant discovery (... active entities)
COV device ...: ... subscribed, ... failed
```

Some BACnet objects do not support COV. Individual COV subscription failures are therefore not automatically fatal; fallback polling remains active.

## MQTT topics

Driver:

```text
bacnet2mqtt/driver/status
bacnet2mqtt/control/scan
bacnet2mqtt/control/read
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

## Multi-State and Priority Release

Multi-State text is taken from BACnet `State_Text` and written back by translating the selected label to its 1-based BACnet state number. `AUTO` is therefore an ordinary Multi-State value when the BACnet device defines it as such.

Priority Release is separate: Home Assistant sends `RELEASE`, and the App writes BACnet NULL at the configured priority.

## First troubleshooting data to send back

If the App does not start or does not discover the expected devices, copy the first startup log from the first `[MQTT]` line through the BACnet scan/discovery lines. Set `log_level` to `debug` if more detail is needed.


## v0.1.2 diagnostics

For discovery, the log now contains lines like:

```text
Device 35: Object_List reports 42 objects
Device 35: Object_List read 42/42
Device 35 (AS680): Object_List=42, supported=36, skipped=6
```

For writes, the log now verifies the configured BACnet Priority_Array slot:

```text
Write ACK 35/19/1 P16: 1
Write verify 35/19/1: P16 slot=1
Write readback ... actual=2
```

If the slot contains the requested value but Present_Value remains different, the
write itself succeeded and a numerically lower (higher precedence) BACnet priority
is controlling the point.


## v0.1.3 - writable analog numbers

Some BACnet controllers expose `Relinquish_Default`, so an AV/AO is correctly
detected as writable, but return equal or placeholder values for
`Min_Pres_Value` and `Max_Pres_Value`. Home Assistant rejects an MQTT Number
configuration where `min >= max`.

v0.1.3 validates the BACnet limits and uses a dynamic fallback range when the
limits are not usable. Startup/scan logs now show, for example:

```text
HA number 35/2/1 (AV_1): min=-100, max=140, step=0.1, value=40
```


## v0.1.4 - BACnet Schedule object

BACnet Object Type `17` (Schedule) is now supported.

The Schedule is exposed to Home Assistant as a read-only sensor. Its state is
the BACnet `Present_Value`. The following Schedule properties are also exposed
as entity attributes when the controller supports them:

- `Schedule_Default`
- `Priority_For_Writing`
- `Effective_Period`
- `Weekly_Schedule`
- `Exception_Schedule`
- `List_Of_Object_Property_References`

Schedule objects are deliberately not subscribed through COV in this release.
They are refreshed by the normal fallback poll and by the Driver's
**BACnet Read** button.

Editing Weekly_Schedule / Exception_Schedule from Home Assistant is not enabled
yet; v0.1.4 is read/discovery support.


## v0.1.5 - editable Schedule weekdays

Each BACnet Schedule object now creates seven Home Assistant MQTT Text controls:

- Monday
- Tuesday
- Wednesday
- Thursday
- Friday
- Saturday
- Sunday

The entities share a JSON state topic and use Home Assistant `value_template`
to extract the selected weekday.

Examples:

```text
08:00=ON;16:00=OFF
```

```text
06:30=AUTO;18:00=OFF
```

```text
07:00=21.5;16:30=18
```

Supported values depend on the BACnet object referenced by
`List_Of_Object_Property_References`:

- Binary: `OFF/ON`, `OFF/ON`, `0/1`
- Multi-State: state name or state number
- Analog: number
- `NULL`: BACnet NULL value

An empty text value (or `-` / `EMPTY`) clears the selected day.

The app reads the current Weekly_Schedule before every write, replaces only the
selected weekday, writes the complete seven-day BACnet Weekly_Schedule, then
reads it back and republishes the resulting value.

### MQTT example

State:

```json
{
  "monday": "08:00=ON;16:00=OFF",
  "tuesday": "",
  "wednesday": "",
  "thursday": "",
  "friday": "",
  "saturday": "",
  "sunday": ""
}
```

Home Assistant MQTT Text uses:

```text
value_template: {{ value_json.monday | default('') }}
```


## v0.1.6 - one full-week Schedule control

Each BACnet Schedule now creates one Home Assistant MQTT Text entity:

```text
<SCHEDULE NAME> - Weekly Schedule
```

Its `value_template` renders the shared JSON state as one editable string:

```text
Monday:08:00=ON;16:00=OFF | Tuesday:- | Wednesday:- | Thursday:- | Friday:- | Saturday:- | Sunday:-
```

The MQTT Discovery command topic is:

```text
bacnet2mqtt/<deviceId>/17/<instance>/schedule/set/week
```

Editing rules:

- separate days with `|`
- day name is followed by `:`
- events are separated with `;`
- event syntax is `HH:MM=VALUE`
- `-`, `EMPTY`, or an empty day means no events for that day
- omitted days are preserved from the current BACnet Weekly_Schedule

Accepted weekday names:
`Monday`, `Tuesday`, `Wednesday`, `Thursday`, `Friday`, `Saturday`, `Sunday`.

English day names are also accepted.


Home Assistant limits Text entity states to 255 characters. The full-week
representation is therefore intended for normal weekly programs with a moderate
number of switching events. If a BACnet Schedule needs more than 255 characters,
the raw schedule remains available in the Schedule sensor attributes and a
future Ingress editor can handle arbitrarily larger programs.


## v0.1.7 - automatic Ingress Schedule editor

Open **BACnet2MQTT -> Open Web UI** or use the BACnet2MQTT sidebar panel.

Each Schedule has one large weekly editor, for example:

```text
Monday:08:00=ON;16:00=OFF | Tuesday:- | Wednesday:- | Thursday:- | Friday:- | Saturday:- | Sunday:-
```

Typing starts a one-second debounce. When typing stops, the app automatically
writes the complete Weekly_Schedule to BACnet. Leaving the field sends any
pending edit immediately.

After a successful write, the app reads Weekly_Schedule back and displays the
confirmed BACnet value.

The native Home Assistant MQTT Text entity remains available, but Home
Assistant itself decides when a native Text control is committed. MQTT
Discovery cannot make the stock frontend publish every keystroke, so the
Ingress editor provides the requested automatic behavior.


## v0.1.8 - Weekly_Schedule write fix

The Ingress editor now uses English weekday labels:

```text
Monday:08:00=ON;16:00=OFF | Tuesday:- | Wednesday:- | Thursday:- | Friday:- | Saturday:- | Sunday:-
```

The Weekly_Schedule write path was corrected for `@bacnet-js/client` 3.3.2.

`writeProperty()` accepts `BACNetWritePropertyValues`, and the library defines a
special `BACNetWeeklySchedulePayload` form. For `Weekly_Schedule`, the seven-day
array must be passed directly:

```js
await client.writeProperty(
  address,
  scheduleObjectId,
  WEEKLY_SCHEDULE,
  weekly, // exactly 7 daily arrays
  options
);
```

The previous implementation wrapped the weekly array in one
`ApplicationTag.WEEKLY_SCHEDULE` value. That produced an outer array containing
only one item, so the library encoder reported that the weekly schedule did not
contain exactly seven days.

Debug logging now reports:

```text
Weekly_Schedule encode 35/17/0: days=7, events=[2,0,0,0,0,0,0]
```


## v0.1.9 - English-only UI

BACnet2MQTT now uses English for all user-facing text.

Binary Schedule values are displayed and edited as:

```text
ON
OFF
```

Example:

```text
Monday:08:00=ON;16:00=OFF | Tuesday:- | Wednesday:- | Thursday:- | Friday:- | Saturday:- | Sunday:-
```

Accepted binary values:

```text
ON / OFF
1 / 0
TRUE / FALSE
ACTIVE / INACTIVE
```

Accepted weekday names are English names and common English abbreviations.


## v0.2.0 - branding and clean first-run configuration

BACnet2MQTT now includes a Home Assistant App icon and logo.

On a new installation the following network settings are intentionally empty:

```text
MQTT broker
BACnet local interface
BACnet broadcast address
```

Example configuration after installation:

```yaml
mqtt_host: ""
bacnet_interface: ""
bacnet_broadcast: ""
```

Enter the addresses appropriate for your own network before starting normal
gateway operation.

If one of the required address fields is empty, the App log explains exactly
which fields still need to be configured and waits without entering a restart
loop.


## v0.2.1 - simpler branding

BACnet2MQTT now uses a simpler square icon.

The large Home Assistant App logo image has been removed intentionally:

- `icon.png` exists
- `logo.png` does not exist

This makes the Home Assistant App rely on the textual App name instead of a
large custom logo banner.


## v0.2.2 - selected BACnet2MQTT icon

The Home Assistant App now uses the selected BACnet2MQTT icon artwork as
`icon.png`.

The icon is stored at 128×128 pixels and uses the complete icon canvas.

`logo.png` is still intentionally omitted, so Home Assistant displays the App
name as text instead of showing a large image logo.


## v0.2.3 - Home Assistant Number precision fix

BACnet `REAL` is a 32-bit floating-point value. A BACnet Resolution that is
conceptually `0.001` may arrive in JavaScript as:

```text
0.0010000000474974513
```

Publishing this raw number as the Home Assistant MQTT Number `step` makes the
browser reject ordinary values such as `1`, `10`, and `100`.

v0.2.3 normalizes BACnet analog min/max/resolution metadata to the useful
precision of BACnet REAL before publishing MQTT Discovery.

Expected log example:

```text
HA number 35/2/1 (AO_1): min=0, max=100, step=0.001,
raw_resolution=0.0010000000474974513, value=100
```

The Home Assistant Number input should then accept `100` normally and the
validation message should disappear. Once the invalid helper text is gone,
the normal entity-row layout also shows the datapoint name correctly.


## v0.2.4 - Ingress removed

Home Assistant Ingress and the built-in BACnet Schedule web editor have been
removed.

BACnet2MQTT now runs only as the BACnet/IP ↔ MQTT gateway. Schedule objects
continue to be discovered and published through Home Assistant MQTT Discovery,
but there is no separate App Web UI or sidebar panel.


## v0.2.5 - analog Number state alignment

v0.2.3 cleaned the MQTT Number metadata (`min`, `max`, `step`), but the live
BACnet `Present_Value` could still contain float32 noise.

For example, a controller value logically equal to:

```text
0.002
```

can decode as:

```text
0.0020000000949949026
```

Home Assistant then receives:

```text
step = 0.001
state = 0.0020000000949949026
```

and the browser considers the state off-step. This produces validation text
such as "nearest valid values are 0.002 and 0.003" and makes the spinner behave
unexpectedly.

v0.2.5 aligns writable AO/AV state values to the same:

```text
min + N × step
```

grid used by Home Assistant Number discovery.

So the MQTT state is now:

```text
0.002
```

and pressing the spinner up arrow produces:

```text
0.003
```

when the BACnet resolution is `0.001`.


## v0.2.6 - bundled BACnet Schedule Card

The Schedule Card is now included in the BACnet2MQTT App itself.

At App startup BACnet2MQTT:

1. copies the bundled card to:

```text
/homeassistant/www/bacnet-schedule-card.js
```

2. connects to the Home Assistant WebSocket API,
3. lists the existing Lovelace resources,
4. creates or updates this module resource:

```text
/local/bacnet-schedule-card.js?v=0.2.3
```

5. creates a persistent Home Assistant notification after an App/Card version
   update asking for a Home Assistant restart and browser hard-refresh.

Manual copying to `/config/www` and manual Dashboard Resource registration are
no longer required.

The card registers `preview: true`, therefore its Community card picker entry
uses the real card preview instead of the generic description tile.

Home Assistant 2026.6+ can also suggest the card automatically when a selected
sensor has:

```text
object_type: schedule
```

The App requires `homeassistant_config:rw` only so it can install the bundled
frontend file into Home Assistant's `www` directory. Home Assistant API access
is used to register the resource and create the restart notification.


## v0.2.7 - Schedule Card uses the Text entity

The BACnet Schedule Card no longer needs a manually configured MQTT command
topic.

Recommended card configuration:

```yaml
type: custom:bacnet-schedule-card
entity: text.idoprogi_weekly_schedule
autosave: false
```

The BACnet2MQTT Schedule Text entity now subscribes to the Schedule attributes
topic as well as the weekly state topic. Therefore the same Text entity contains:

```yaml
present_value: 1
object_type: schedule
object_instance: 0
weekly_schedule: ...
controlled_object: ...
```

The compact card uses `present_value` automatically:

```text
1 -> green dot
0 -> gray dot
```

No separate `state_entity` is needed.

The card writes through Home Assistant `text.set_value`, which publishes to the
Text entity's MQTT command topic configured by BACnet2MQTT Discovery.

Note: Home Assistant MQTT Text values are limited to 255 characters. Very dense
weekly schedules can exceed this limit.


## v0.2.8 - Text entity Schedule attributes fix

v0.2.7 already published the Schedule JSON attributes payload to:

```text
bacnet2mqtt/<device_id>/17/<instance>/attributes
```

but the MQTT Discovery `json_attributes_topic` entry was accidentally applied
only to the Schedule sensor and not to the `Weekly Schedule` Text entity.

v0.2.8 fixes the Text discovery configuration:

```yaml
state_topic: bacnet2mqtt/<device_id>/17/<instance>/schedule
json_attributes_topic: bacnet2mqtt/<device_id>/17/<instance>/attributes
command_topic: bacnet2mqtt/<device_id>/17/<instance>/schedule/set/week
```

After the App republishes discovery, the Text entity receives attributes such as:

```yaml
object_type: schedule
object_instance: 0
present_value: 1
priority_for_writing: 4
weekly_schedule:
  monday: 08:00=1;16:00=0
```
\n\n## v0.3.0 - Ingress Device & Point Manager\n\nThe App now includes an Ingress web interface. Home Assistant authentication is\nhandled by Ingress; the App does not expose a separate login page.\n\nApp configuration includes:\n\n```yaml\ningress: true\ningress_port: 8099\npanel_icon: mdi:lan-connect\npanel_title: BACnet2MQTT\npanel_admin: true\n```\n\n### Devices\n\nThe left device panel shows:\n\n- display name\n- BACnet Device ID\n- network address\n- point count\n- green online indicator or gray offline indicator\n\nDevice names are application/display overrides. They update the Home Assistant\nMQTT Discovery device name but do not write the physical BACnet Device\n`Object_Name`.\n\nDelete removes a device from BACnet2MQTT, its cache and its Home Assistant MQTT\nDiscovery entities. It does **not** delete or reconfigure the physical BACnet\ncontroller. Deleted device IDs are stored in `/data/ui-settings.json`, ignored\nduring normal discovery, and can be restored from the Deleted devices section.\n\n### Data points\n\nSelecting a device displays all supported points. Current values are read from\nthe Gateway cache, which is updated by COV and polling. The page refreshes live\nvalues without replacing an input while the user is editing it.\n\nWritable controls use the existing BACnet2MQTT write path, including the\nconfigured BACnet priority, Priority_Array verification, readback and Release.\n\nPoint settings include:\n\n- display name\n- analog minimum\n- analog maximum\n- analog step / resolution\n\nThese are BACnet2MQTT/Home Assistant presentation overrides. Min/max/step do not\nwrite `Min_Pres_Value`, `Max_Pres_Value` or `Resolution` back to the controller.\nThey control the MQTT Discovery Number configuration and the Ingress editor.\n`Reset to BACnet` returns to the values discovered from the controller.\n\nOverrides are persisted in:\n\n```text\n/data/ui-settings.json\n```\n

## v0.3.1 - modern Ingress UI and reboot workflow

The Ingress device manager was redesigned around the BACnet2MQTT icon palette.
The interface now uses a compact device sidebar, live online/offline counters, a
device hero, summary cards and cleaner point controls/settings.

After an App or bundled frontend update BACnet2MQTT no longer creates a passive
Home Assistant persistent notification. Instead it writes a restart-required
marker to `/data/homeassistant-restart-required.json`.

When the Ingress page opens, it displays:

```text
Home Assistant reboot required

[ Later ] [ Submit ]
```

`Submit` calls Supervisor's authenticated `/core/restart` endpoint. The restart-required flag is cleared as
the restart is requested. If the request fails immediately, the flag is restored
so the action can be retried.

The App also declares:

```yaml
watchdog: "tcp://[HOST]:8099"
```

so Supervisor can monitor the Ingress listener and recover the App if the
process is not serving its TCP port.

Important for local development: replacing files in the local `/addons` source
folder does not by itself restart an already running container. Supervisor still
has to apply the App update/rebuild. Once the new container is started, the
watchdog and restart-required workflow apply.


## v0.3.3 - Schedule configuration and native reboot workflow

### Schedule configuration

Each BACnet Schedule can have a UI override stored in `/data/ui-settings.json`:

```json
{
  "mode": "binary",
  "valueType": "enumerated",
  "onText": "ON",
  "onValue": "1",
  "offText": "OFF",
  "offValue": "0",
  "nullText": "Empty",
  "unit": "",
  "min": null,
  "max": null,
  "step": null,
  "states": []
}
```

Supported modes are `binary`, `states`, and `number`. Supported BACnet write types are `auto`, `enumerated`, `boolean`, `real`, `unsigned`, and `signed`. Named states are configured as display/raw pairs such as `AUTO=3`.

The Ingress editor writes Weekly_Schedule directly through the gateway and therefore does not have the Home Assistant MQTT Text 255-character limitation.

### Lovelace Schedule Card

The bundled card is v0.3.3. It reads `schedule_config` and `present_value_text` from the Weekly Schedule Text entity attributes. A raw program containing `08:00=1;16:00=0` is displayed as `ON` and `OFF` by default.

### Native Home Assistant reboot prompt

BACnet2MQTT no longer shows a custom reboot popup in Ingress. Discovery creates an MQTT Update entity on the Driver device:

```text
Home Assistant Reboot Required
```

When `/data/homeassistant-restart-required.json` is set, the entity reports a newer version and Home Assistant renders its normal Update/Firmware dialog. Its command topic is:

```text
bacnet2mqtt/control/homeassistant-restart
```

The Update action sends `RESTART`; BACnet2MQTT clears the pending flag and calls the Supervisor `/core/restart` endpoint.

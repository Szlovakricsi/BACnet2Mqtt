# Changelog

## 0.3.3

- Rebuilt BACnet Schedule Card as v0.3.3 with a flat Home Assistant update-dialog inspired design.
- Schedule cells now display configured text labels even when BACnet stores raw `1`, `0` or other values. Default binary presentation is `ON=1`, `OFF=0`, and empty cells represent no scheduled event.
- Added per-Schedule presentation/write configuration in the Ingress Web UI:
  - Schedule mode: Binary ON/OFF, Named states, Numeric
  - BACnet value type: Auto, Enumerated, Boolean, REAL, Unsigned integer, Signed integer
  - ON text + raw value
  - OFF text + raw value
  - NULL/empty text
  - unit, minimum, maximum and step
  - arbitrary named-state mappings (`Text=Value`)
- Added a full weekly Schedule editor to Ingress. Every Monday-Sunday half-hour cell can be edited and the complete Weekly_Schedule is written directly over BACnet, without Home Assistant Text's 255-character limit.
- Schedule MQTT attributes now include `schedule_config`, `present_value_text`, and `device_name`, allowing the Lovelace card to configure itself automatically.
- Schedule sensor state is human-readable for binary/named-state programs while numeric programs remain numeric and can expose a unit.
- Removed the custom Ingress restart popup/badge.
- Added a native MQTT Update entity named `Home Assistant Reboot Required` on the BACnet2MQTT Driver device. When a frontend restart is required it becomes an available update; opening it uses Home Assistant's native Update/Firmware dialog. Pressing **Update** sends the restart command and restarts Home Assistant Core.
- The reboot-required update state is retained and re-published after Home Assistant reconnects.


## 0.3.2

- Fixed the Ingress Web UI not visually changing after the v0.3.1 redesign.
- Root cause: `web/index.html` did not load `styles.css`, so the redesigned CSS bundle was never applied.
- Converted the Ingress entry page to a complete HTML document with explicit stylesheet and script references.
- Added cache-busting query strings: `styles.css?v=0.3.2` and `app.js?v=0.3.2`.
- Static Web UI assets continue to use `Cache-Control: no-store`.
- Added a visible `Web UI v0.3.2` label under the BACnet2MQTT title.
- Browser console now prints `[BACnet2MQTT Web UI] v0.3.2 loaded`.


## 0.3.1

- Reworked the Ingress UI with a cleaner modern dashboard layout inspired by the BACnet2MQTT project icon: cyan/blue, purple and orange accents on a dark neutral background.
- Added device online/offline counters and per-device summary cards for total points, writable points and configured overrides.
- Improved point cards, controls, expanded point settings, dialogs, responsive mobile layout and visual hierarchy.
- Removed the passive Home Assistant persistent notification used after BACnet2MQTT/frontend updates.
- Added an interactive `Home Assistant reboot required` dialog in the Ingress UI.
- The dialog contains a `Submit` action that requests a Home Assistant Core restart through the authenticated Supervisor `/core/restart` endpoint.
- A restart-required badge remains visible in the header when the dialog is postponed with `Later`.
- The restart-required state is persisted under `/data` until the user submits the restart.
- Added a Supervisor TCP watchdog for the Ingress service on port 8099.
- Ingress HTML, JavaScript and CSS are now served with `no-store` to avoid stale UI assets after an App update.


## 0.3.0

- Added a full Home Assistant Ingress web interface on port 8099.
- Modern dark UI using the cyan / blue / purple / orange palette of the BACnet2MQTT project icon.
- Device panel shows every discovered BACnet device with live online/offline indication, address and point count.
- Devices can be renamed from the UI. The display-name override is persisted in `/data/ui-settings.json` and is applied to Home Assistant MQTT Discovery.
- Devices can be deleted from BACnet2MQTT without modifying the physical controller. Deletion removes the cached device and its MQTT Discovery entities and keeps the device on a restorable deleted-device list.
- Restoring a deleted device starts a new BACnet discovery scan.
- Selecting a device shows all supported data points with current value, BACnet object type/instance, unit, writable status and live refresh.
- Writable AO/AV values can be set from the web UI and released at the configured BACnet priority.
- Writable BO/BV points have an ON/OFF (1/0) control and priority release.
- Writable MSO/MSV points have a state selector and priority release.
- Point display names can be overridden from the UI and republished to Home Assistant Discovery.
- Analog point minimum, maximum and step can be overridden from the UI and immediately republished to Home Assistant Number discovery.
- A Reset to BACnet action removes point overrides and restores discovered BACnet metadata.
- Added Scan BACnet, Read all and per-device Read controls.
- UI settings survive App restarts and BACnet rediscovery.
- Ingress access is restricted to the Home Assistant Ingress proxy (plus loopback for local health/testing).


## 0.2.8

- Fixed `Present Value unavailable` on the bundled BACnet Schedule Card.
- v0.2.7 published the Schedule attributes topic correctly, but accidentally added `json_attributes_topic` only to the Schedule sensor discovery config.
- The Weekly Schedule MQTT Text entity now correctly includes:
  `json_attributes_topic: bacnet2mqtt/<device>/17/<instance>/attributes`
- Existing Text entities are updated in place by retained MQTT Discovery after the App restarts.
- The Text entity now receives `present_value`, `object_type`, `object_instance`, `weekly_schedule`, `priority_for_writing`, and the remaining Schedule attributes.
- The card can therefore show:
  - Present Value `1` -> green dot
  - Present Value `0` -> gray dot


## 0.2.7

- Bundles BACnet Schedule Card v0.2.4.
- The Schedule Card now uses the Home Assistant MQTT `text` entity as its primary read/write interface.
- `command_topic` is no longer required in normal card configuration.
- Added the Schedule `json_attributes_topic` to the MQTT Text discovery entity.
- The Weekly Schedule Text entity now automatically receives `present_value`, `object_instance`, `weekly_schedule`, `controlled_object`, and the other Schedule attributes.
- The card reads `present_value` directly from the Text entity:
  - `1` -> green status dot
  - `0` -> gray status dot
- `state_entity` is no longer required.
- Card title is automatically derived from the Text entity friendly name when `title` is omitted.
- Card picker suggestions now target BACnet2MQTT Schedule `text.*` entities.
- Legacy `command_topic`, `schedule_entity`, and `state_entity` configurations remain supported as fallbacks.
- Home Assistant MQTT Text has a hard 255-character maximum; the card reports a clear error if a very dense weekly program exceeds it.


## 0.2.6

- Bundles BACnet Schedule Card v0.2.3 directly with the BACnet2MQTT App.
- The App automatically installs the card to `/homeassistant/www/bacnet-schedule-card.js`.
- The App automatically lists Lovelace resources and creates or updates `/local/bacnet-schedule-card.js?v=0.2.3` as a JavaScript module.
- Existing manually registered BACnet Schedule Card resources are upgraded automatically.
- The custom card picker now uses `preview: true`, so the Community card tile renders the card itself instead of a generic text-only placeholder.
- Added Home Assistant 2026.6+ entity suggestion support for BACnet Schedule sensors.
- After an App/card version update, BACnet2MQTT creates a persistent Home Assistant notification asking for one Home Assistant restart and browser hard-refresh.
- Added `homeassistant_config:rw` mapping and Home Assistant API access only for frontend card installation/registration and update notification.
- The frontend installer runs even before BACnet/MQTT network addresses are configured.


## 0.2.5

- Fixed writable analog Home Assistant Number states still carrying raw BACnet REAL float32 noise.
- Example: `0.0020000000949949026` is now published as `0.002`.
- Writable AO/AV states are aligned to the published `min + N × step` grid before MQTT state publication.
- This fixes browser validation messages even when `step` itself was already corrected in v0.2.3.
- Number spinner up/down controls now advance using the expected BACnet resolution, e.g. `0.001`.
- Read-only analog sensors are not quantized by this change.


## 0.2.4

- Removed Home Assistant Ingress support completely.
- Removed the internal Schedule web editor and `web.js`.
- Removed `ingress`, `ingress_port`, and all sidebar panel settings from `config.yaml`.
- BACnet Schedule discovery, MQTT entities, reading and writing remain available.
- No BACnet, MQTT, COV, discovery, Priority Release, or Number behavior was otherwise changed.


## 0.2.3

- Fixed Home Assistant Number validation errors caused by raw BACnet REAL/float32 precision.
- BACnet resolutions such as `0.0010000000474974513` are normalized to `0.001` before MQTT Discovery is published.
- BACnet analog min/max metadata is normalized with the same float32 cleanup.
- Values such as `1`, `10` and `100` no longer produce browser messages about the nearest valid values.
- This also prevents the validation helper text from expanding/overlapping the device-row layout and hiding the datapoint name.
- Added `raw_resolution` to Number discovery logs for diagnostics.


## 0.2.2

- Replaced the Home Assistant App icon with the selected BACnet2MQTT artwork.
- The new icon uses the full 128×128 icon area and keeps its transparent outer background.
- `logo.png` remains intentionally absent, so the App name is shown as text instead of a large logo banner.
- No functional BACnet/MQTT behavior changed in this release.


## 0.2.1

- Removed `logo.png` so Home Assistant shows the App name as text instead of a large custom logo banner.
- Replaced the previous logo artwork with a simpler text-based `icon.png`.
- The App keeps its square icon, but the larger logo presentation is intentionally disabled.
- Kept the empty default network address fields introduced in v0.2.0.


## 0.2.0

- Added BACnet2MQTT branding with `icon.png` and `logo.png`.
- The new pastel BACnet2MQTT data-flow artwork is used as the Home Assistant App icon/logo.
- Removed all pre-filled IP/host addresses from the default App configuration.
- `mqtt_host`, `bacnet_interface`, and `bacnet_broadcast` now start empty on a new installation.
- Added startup configuration validation with a clear log message when required network addresses have not been configured.
- An unconfigured App stays running instead of repeatedly crashing/restarting, so the Configuration and Log tabs remain accessible.


## 0.1.9

- Changed binary Schedule values from `ON/OFF` aliases to the canonical displayed format `ON/OFF`.
- Schedule editing now uses `ON/OFF` or numeric `1/0`.
- Removed non-English weekday aliases; Schedule input is English-only.
- All weekday labels are English: Monday through Sunday.
- Changed the remaining Home Assistant entity label to `BACnet Status`.
- Changed the complete Ingress Schedule editor UI to English.
- The `hu.yaml` App translation intentionally mirrors the English translation, so BACnet2MQTT remains English even when Home Assistant is configured for Hungarian.
- Updated all shipped examples and documentation to English.


## 0.1.8

- Fixed BACnet Weekly_Schedule writes with @bacnet-js/client 3.3.2.
- The library expects `BACNetWeeklySchedulePayload` directly as the `writeProperty()` values argument.
- Removed the incorrect outer `{ type: WEEKLY_SCHEDULE, value: weekly }` wrapper which made the encoder see only one day and caused:
  `Could not encode: weekly schedule should have exactly 7 days`.
- Weekly payload is now normalized to exactly seven daily arrays before every write.
- Added debug logging showing the encoded day count and number of events per day.
- Changed all displayed Schedule weekday names to English: Monday through Sunday.
- Common English weekday abbreviations are accepted by the parser.


## 0.1.7

- Added Home Assistant Ingress Schedule editor.
- Editing a Schedule starts a 1 second debounce; after typing stops the complete week is written automatically to BACnet.
- Leaving the editor sends a pending edit immediately.
- No Enter/checkmark/manual MQTT publish is needed in the Ingress editor.
- The Schedule is read back after writing and the confirmed BACnet program replaces the editor value.
- BACnet write errors are shown directly below the Schedule field.
- Added BACnet2MQTT sidebar/Web UI entry.


## 0.1.6

- Replaced the seven separate Schedule weekday MQTT Text entities with one large editable weekly Schedule entity.
- The full-week entity uses one Home Assistant `value_template` to format Monday through Sunday.
- Display/edit format:
  `Monday:08:00=ON;16:00=OFF | Tuesday:- | Wednesday:- | Thursday:- | Friday:- | Saturday:- | Sunday:-`
- The weekly command updates all days present in the edited string while preserving any omitted days.
- `-`, `EMPTY`, or an empty day section clears that day.
- English weekday names and common English abbreviations are accepted.
- Old v0.1.5 per-day Home Assistant Text entities are removed automatically through retained MQTT Discovery cleanup.
- The old per-day MQTT command topics remain supported for compatibility.


## 0.1.5

- Fixed BACnet Schedule TIME presentation: local controller times are no longer shown one hour early as UTC ISO timestamps.
- BACnet wildcard Effective_Period dates (255/255/255) are now presented as unrestricted instead of 1899/1900 dates.
- Added editable Home Assistant MQTT Text controls for all seven Schedule weekdays.
- Schedule Text controls use Home Assistant `value_template` against one shared JSON schedule state topic.
- Editable syntax is compact and human-readable, for example: `08:00=ON;16:00=OFF`.
- Binary schedules accept `OFF/ON`, `OFF/ON`, or `0/1`.
- Multi-State schedules accept state names or numeric state indices.
- Analog schedules accept numeric values.
- Empty text clears the selected weekday.
- Only the selected weekday is changed; the app reads the latest Weekly_Schedule first and preserves the other six days.
- Schedule writes use the schedule/calendar write support added to @bacnet-js/client 3.2+ and are read back after writing.


## 0.1.4

- Added BACnet Schedule object support (Object Type 17).
- Schedule objects are now discovered from the BACnet Device Object_List.
- Schedule Present_Value appears in Home Assistant as a read-only sensor.
- Home Assistant Schedule sensors expose MQTT attributes for:
  - Schedule_Default
  - Priority_For_Writing
  - Effective_Period
  - Weekly_Schedule
  - Exception_Schedule
  - List_Of_Object_Property_References
- Schedule metadata is refreshed during normal/manual full reads.
- Schedule objects intentionally use polling instead of COV subscription.


## 0.1.3

- Fixed writable Analog Value/Analog Output entities disappearing from Home Assistant.
- Validates BACnet `Min_Pres_Value` / `Max_Pres_Value` before publishing MQTT Number discovery.
- Controllers that report invalid/equal limits (for example 0/0) now get a safe dynamic fallback range around the current value.
- Enforces Home Assistant MQTT Number minimum step of 0.001.
- Logs the generated Home Assistant number range for every writable analog point.


## 0.1.2

- Object_List discovery now uses indexed reads (index 0 + 1..N) to avoid silently truncated object lists.
- Discovery logs now show total Object_List size, supported/skipped objects and object-type counts.
- BACnet reads/writes now pass the device max APDU value when known.
- Write verification now reads the configured Priority_Array slot.
- Write logs distinguish an accepted BACnet write from a Present_Value blocked by a higher priority.
- Priority Release is verified against the Priority_Array slot.
- Readback logs now include the actual value.


## 0.1.1

- Fixed `@bacnet-js/client` constructor resolution under Home Assistant Node.js runtime.
- Added BACnet library constructor startup diagnostic.


## 0.1.0

Initial experimental build.

- BACnet/IP Who-Is / I-Am discovery
- Object_List point discovery
- AI, AO, AV, BI, BO, BV, MSI, MSO and MSV entities
- writable/commandable detection using Relinquish_Default
- Home Assistant MQTT Discovery
- BACnet WriteProperty priority 1-16
- Priority Release via BACnet NULL
- write readback/retry
- Driver device with Scan, Read and Driver Status
- MQTT Birth / Last Will availability
- per-device online/offline state
- Driver + device double availability for all point entities
- fallback polling and health checking
- offline -> online device rediscovery
- COV subscription and renewal
- persistent cache under /data

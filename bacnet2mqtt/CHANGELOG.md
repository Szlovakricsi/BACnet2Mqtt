# Changelog

## 0.4.3

- Standardized the Home Assistant MQTT Discovery gateway device name as **BACnet Driver**. The stable MQTT topic namespace remains `bacnet2mqtt/driver/...`.
- Added unsaved-change tracking to datapoint settings in the Ingress Web UI.
- The datapoint **Save** button now pulses orange/yellow whenever any settings field has been changed but not yet saved.
- Pressing **Save** clears the dirty indication only after the point configuration request succeeds.
- Closing an open datapoint settings panel now automatically saves pending changes before closing.
- If the automatic save fails, the panel remains open and the dirty/pulsing state remains visible so edits are not silently lost.
- Updated the root README, App README and `DOCS.md` for the bidirectional BACnet/Home Assistant architecture and current Web UI behavior.

## 0.4.2

- Fixed BACnet/IP broadcast discovery from other machines such as YABE.
- The BACnet UDP listener now binds to `0.0.0.0:<bacnet_port>` instead of only the configured host interface address, allowing subnet broadcast Who-Is datagrams to reach the socket on Linux.
- The configured BACnet broadcast address remains in use for outgoing BACnet broadcasts.

## 0.4.1

- Removed the IP/port-based Who-Is suppression that could prevent valid BACnet discovery requests from being answered.
- The virtual Home Assistant BACnet Device now answers valid Who-Is requests regardless of the requester's host address, while still honoring optional Device Instance ranges.
- The gateway ignores the virtual Home Assistant Device's own I-Am in the physical-controller discovery path instead of suppressing Who-Is responses.
- Added Who-Is response logging for the virtual Home Assistant BACnet Device.

## 0.4.0

- Added Home Assistant → BACnet entity export.
- Added a virtual BACnet Device that shares the existing gateway BACnet/IP socket and exposes selected Home Assistant entities.
- Added Analog Value, Binary Value and CharacterString Value export types.
- Added ReadProperty, ReadPropertyMultiple, Who-Is/I-Am and supported WriteProperty handling for the virtual device.
- Added supported BACnet writes back to Home Assistant service calls for common writable entity domains.
- Added the **HA → BACnet** Ingress workspace and persistent `/data/ha-bacnet-export.json` configuration.

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
- The Weekly Schedule MQTT Text entity now correctly includes `json_attributes_topic: bacnet2mqtt/<device>/17/<instance>/attributes`.
- Existing Text entities are updated in place by retained MQTT Discovery after the App restarts.
- The Text entity now receives `present_value`, `object_type`, `object_instance`, `weekly_schedule`, `priority_for_writing`, and the remaining Schedule attributes.

## 0.2.7

- Bundles BACnet Schedule Card v0.2.4.
- The Schedule Card now uses the Home Assistant MQTT `text` entity as its primary read/write interface.
- `command_topic` is no longer required in normal card configuration.
- Added the Schedule `json_attributes_topic` to the MQTT Text discovery entity.
- The Weekly Schedule Text entity now automatically receives `present_value`, `object_instance`, `weekly_schedule`, `controlled_object`, and the other Schedule attributes.
- `state_entity` is no longer required.
- Legacy configurations remain supported as fallbacks.

## 0.2.6

- Bundled the BACnet Schedule Card directly with the App.
- Added automatic installation into Home Assistant `www` and automatic Lovelace resource registration/update.
- Added update/restart notification support after frontend resource changes.

## 0.2.5

- Fixed writable analog Home Assistant Number states carrying raw BACnet REAL float32 noise.
- Writable AO/AV states are aligned to the published `min + N × step` grid before MQTT state publication.

## 0.2.4

- Temporarily removed Home Assistant Ingress and the internal Schedule web editor while retaining BACnet/MQTT gateway and Schedule functionality.

## 0.2.3

- Fixed Home Assistant Number validation errors caused by raw BACnet REAL/float32 precision.
- Normalized analog min/max/resolution metadata before MQTT Discovery publication.

## 0.2.2

- Replaced the Home Assistant App icon with the selected BACnet2MQTT artwork.

## 0.2.1

- Simplified App branding and removed the large `logo.png` presentation.

## 0.2.0

- Added BACnet2MQTT branding.
- Removed pre-filled network addresses from default configuration.
- Added startup validation for required MQTT/BACnet address fields.

## 0.1.9

- Standardized the user-facing UI and Schedule vocabulary to English.

## 0.1.8

- Fixed BACnet Weekly_Schedule writes for `@bacnet-js/client` 3.3.2.
- Normalized the Weekly_Schedule payload to exactly seven daily arrays.

## 0.1.7

- Added the first Home Assistant Ingress Schedule editor with automatic write-on-edit behavior.

## 0.1.6

- Replaced seven separate Schedule weekday MQTT Text entities with one full-week entity.

## 0.1.5

- Fixed BACnet Schedule TIME presentation and wildcard Effective_Period handling.
- Added editable Schedule weekday controls.

## 0.1.4

- Added BACnet Schedule Object Type 17 discovery and read support.

## 0.1.3

- Fixed writable Analog Value/Analog Output Home Assistant Number discovery when BACnet min/max metadata is invalid.

## 0.1.2

- Changed Object_List discovery to indexed reads.
- Added APDU-aware read/write behavior and priority-array verification.

## 0.1.1

- Fixed `@bacnet-js/client` constructor resolution under the Home Assistant Node.js runtime.

## 0.1.0

Initial experimental build with BACnet/IP discovery, MQTT Discovery, BACnet writes, priority release, availability, polling, COV and persistent cache support.

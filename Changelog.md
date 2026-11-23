# Changelog

## 2.1.2 (2026-11-23)

- Standardize GPIO configuration exclusively on BCM/libgpiod line offsets; no implicit physical-pin conversion is performed.

## 2.1.1 (2026-11-23)

- Restore compatibility with original configurations that store `activeLow` as text and use physical Raspberry Pi header pins; these are migrated safely to BCM offsets in memory.

## 2.1.0 (2026-11-23)

- Replace `node-libgpiod` and its obsolete libgpiod 1.x API with direct libgpiod 2.x calls through maintained Koffi FFI.
- Keep one persistent GPIO request per chip for the lifetime of Homebridge; no Python helper or short-lived shell command is used.
- Apply direction, polarity, and initial logical inactive values atomically when acquiring lines.
- Write each blind's outputs together so direction and Somfy DCT stop transitions cannot leave a stale relay active.
- Drive every output inactive before releasing requests at shutdown and document the required external hardware bias.
- Preserve existing configuration, BCM numbering, `gpioChip`, active-low behavior, pulses, timers, HomeKit services, and accessory UUIDs.
- Add Raspberry Pi 5 / Debian 13 deployment instructions and mock-backed GPIO safety tests.
- Declare Node.js 26 support in addition to Node.js 22.12 and 24.

## 2.0.2 (2026-11-03)

- Require Homebridge 2 and supported Node.js 22.12/24 releases.
- Request GPIO outputs directly in their inactive state to prevent relay pulses during startup.
- Handle missing or unavailable GPIO without crashing Homebridge and reject hardware commands cleanly.
- Release GPIO lines and clear timers during Homebridge shutdown.
- Keep target, current, movement, and cached positions synchronized.
- Apply documented defaults for stop line, GPIO chip, pulse duration, relay polarity, and transition duration.
- Validate duplicate names, GPIO ranges, and conflicting lines before reserving hardware.
- Update the native GPIO dependency and development toolchain.
- Add local automated tests; remove the GitHub Node.js build workflow.

## 2.0.1

- Complete the libgpiod package update for the Homebridge 2 release.

## 2.0.0

- Replace the deprecated `rpi-gpio`/sysfs backend with `node-libgpiod`.
- Change GPIO configuration from physical board pin numbers to BCM/libgpiod line numbers.

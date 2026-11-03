# Changelog

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

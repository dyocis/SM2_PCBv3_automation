# Changelog

All notable public changes will be recorded here. This personal project is maintained on a best-effort basis and has no promised release schedule.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Interactive and command-line selection of optional UV lights, exhaust servo, and advanced/beta Peltier hardware.
- Runtime capability detection, safe no-op behavior for absent outputs, and dashboard `NOT INSTALLED` states.

### Safety

- Peltier selection now requires the exhaust servo, and unsupported Peltier-without-servo configurations fault at startup.
- Documented that Peltier hot-side/cold-side thermistor monitoring is not included yet and is planned for a future release.

## [0.1.0] - 2026-08-11

### Added

- Public, sanitized Klipper configuration for Nevermore StealthMax V2 with Isik's Tech PCB v3.
- Dual BME280 + SGP40 material-aware automation and guarded clean-air calibration.
- Standalone Moonraker dashboard with Mainsail navigation integration and direct Fluidd access.
- Installer, uninstaller, Moonraker update configuration, repository validation, and release automation.

### Known limitations

- This release assumes the Peltier cooler, UV LEDs, and exhaust servo are installed. Users without those optional add-ons should not install `v0.1.0`; optional-hardware support is planned for `v0.2.0`.

[Unreleased]: https://github.com/dyocis/SM2_PCBv3_automation/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dyocis/SM2_PCBv3_automation/releases/tag/v0.1.0

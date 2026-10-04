# Changelog

All notable public changes will be recorded here. This personal project is maintained on a best-effort basis and has no promised release schedule.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Compact tabbed dashboard with Live, History, Media, and guarded Controls views.
- Official Nevermore3D mark and selected transparent StealthMax V2 artwork with retained source provenance.
- Local `nevermore-history.service` recorder with 10-second samples, 24-hour retention, restart quarantine, and atomic history writes outside the Git checkout.
- Runtime tests for the dashboard, history guards, recorder, controls, and Moonraker CORS configuration.

### Changed

- Dashboard installation now configures the Nginx history route, exact Moonraker CORS origin, recorder service, and Mainsail link idempotently.
- Uninstall removes only the CORS entry owned by this installer and preserves recorded history.

### Fixed

- Fresh dashboard installs no longer fail their WebSocket connection because the port `7131` origin is missing from Moonraker authorization.
- Closed exhaust vents now render as `CLOSED` instead of the generic output label `OFF`.

- Fan blades now rotate around the hub while their outer frame stays stationary.
- Recorder smoke test waits for an actual sample instead of racing the initial empty history write.

### Upgrade

- Existing installations must rerun `scripts/install.sh --skip-dependencies` from the updated `main` checkout while the printer is idle, then hard-refresh the dashboard. This installs the recorder, history route, and CORS integration while preserving local hardware settings and saved data.

### Safety

- Dashboard controls call only macros defined by this public configuration, retain confirmation prompts, and never issue direct pin, fan, or printer-emergency commands.

## [0.2.0]

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

- This release assumes the Peltier cooler, UV LEDs, and exhaust servo are installed. Users without those optional add-ons should not install `v0.1.0`; this limitation is removed in `v0.2.0`.

[Unreleased]: https://github.com/dyocis/SM2_PCBv3_automation/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/dyocis/SM2_PCBv3_automation/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/dyocis/SM2_PCBv3_automation/releases/tag/v0.1.0

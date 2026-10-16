# Changelog

All notable public changes will be recorded here. This personal project is maintained on a best-effort basis and has no promised release schedule.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> Planned next version: **v0.3.0** (not tagged or published yet). The Peltier auto-cooling and thermistor thermal-limit features remain **disabled by default**.

### Added

- Compact tabbed dashboard with Live, History, Media, and guarded Controls views.
- UV LED and Peltier thermal-history graphs now annotate recorded ON/OFF output transitions and active windows without inventing events across recorder gaps or restarts.
- Official Nevermore3D mark and selected transparent StealthMax V2 artwork with retained source provenance.
- Local `nevermore-history.service` recorder with 10-second samples, 24-hour retention, restart quarantine, and atomic history writes outside the Git checkout.
- Runtime tests for the dashboard, history guards, recorder, controls, and Moonraker CORS configuration.
- Optional Peltier hot/cold thermistor telemetry in `NEVERMORE_STATUS`, live and control dashboard views, and the 24-hour temperature history graph.
- Opt-in Peltier-only thermal protection with configurable hot/cold limits, prestart inhibit, a latched active-operation fault, separate reset, and retained fan cooldown.
- Opt-in air-temperature hysteresis for Peltier cooling independent of the VOC emergency band, with configurable ON/OFF temperatures and a separate automatic status readout.
- Independent temperature-driven post-print vent window with a configurable target and one-shot maximum runtime; VOC treatment can continue after the vent closes.
- Software-only Klipper/Jinja regression tests for optional-sensor installations, active-only thermal trips, exhaust priority, fan airflow, cooldown and vent readiness.

### Changed

- Dashboard installation now configures the Nginx history route, exact Moonraker CORS origin, recorder service, and Mainsail link idempotently.
- Uninstall removes only the CORS entry owned by this installer and preserves recorded history.
- VOC does not open the exhaust in any automatic mode. During prints the vent follows the material temperature target and hysteresis; after prints it follows a separate temperature target and maximum open-time cap (35°C / 60 minutes by default), independent of VOC. High VOC continues internal fan/guarded UV treatment. Automatic Peltier operation remains temperature-driven and independently inhibited by VOC emergency.
- Filter fan demand remains at full speed while the Peltier is active, waiting for airflow, or completing its cooldown.

### Fixed

- Fresh dashboard installs no longer fail their WebSocket connection because the port `7131` origin is missing from Moonraker authorization.
- Closed exhaust vents now render as `CLOSED` instead of the generic output label `OFF`.

- Fan blades now rotate around the hub while their outer frame stays stationary.
- Recorder smoke test waits for an actual sample instead of racing the initial empty history write.
- A vent that is logically closed but not yet ready after startup now completes its six-second close/readiness confirmation.

### Upgrade

- Existing installations upgrading from v0.2.1 (or earlier) should rerun `scripts/install.sh --skip-dependencies` from the updated `main` checkout while the printer is idle, then hard-refresh the dashboard. This installs the recorder, history route, and CORS integration while preserving local hardware settings and saved data.
- Users already running the feature-branch dashboard and recorder can update the Git checkout and restart Klipper without reinstalling the optional services, if those services were previously installed correctly.
- Private `SM2_Local_Hardware.cfg` is preserved. Existing printers will not automatically gain new settings: `peltier_auto_enabled` defaults to `0` when absent.

### Safety

- Dashboard controls call only macros defined by this public configuration, retain confirmation prompts, and never issue direct pin, fan, or printer-emergency commands.
- Peltier thermal enforcement stays disabled until valid, hardware-specific limits are configured; the sample 60°C limits are **not** rated for high-temperature chambers.
- Temperature-triggered starts are inhibited before energizing when protection is enabled but sensors, bounds, or current temperatures are invalid. Only faults during active Peltier operation are latched.
- Filtration remains available through a Peltier-only temperature fault; fan cooling is retained.
- UV LED thermistor monitoring and UV-only protection are not included in this candidate (tracked separately in issue #8).

## [0.2.1]

### Fixed

- Maintenance and installer reliability improvements published in the existing `v0.2.1` tag.

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

[Unreleased]: https://github.com/dyocis/SM2_PCBv3_automation/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/dyocis/SM2_PCBv3_automation/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/dyocis/SM2_PCBv3_automation/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/dyocis/SM2_PCBv3_automation/releases/tag/v0.1.0

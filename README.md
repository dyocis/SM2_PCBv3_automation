# SM2 PCB v3 automation

Klipper automation and a live Moonraker dashboard for the Nevermore StealthMax V2 using Isik's Tech PCB v3, two BME280 + SGP40 sensor modules, a tachometer fan, UV output, Peltier cooling, servo vent, and addressable status LEDs.

> [!IMPORTANT]
> This is a personal, best-effort project. I intend to continue improving the public files when I can, but I cannot promise ongoing support or a regular update schedule. You are responsible for your own printer, wiring, configuration, safety checks, and any software you install. This project is provided as-is, without warranty; I accept no responsibility for damage, failed prints, downtime, injury, or other issues arising from its installation or use.

## Official hardware and support scope

This configuration was developed for these specific parts:

- [Isik's Tech Nevermore StealthMax PCB v3](https://store.isiks.tech/products/nevermore-stealthmax-pcb-3)
- Two [Isik's Tech BME280 + SGP40 air-quality sensor modules](https://store.isiks.tech/products/bme280-sgp40-air-quality-sensors-for-nevermore-air-filters)
- [Isik's Tech StealthMax PCB v3 wiring documentation](https://docs.isiks.tech/Nevermore/SM3-PCB/)
- [Isik's Tech firmware and software setup](https://docs.isiks.tech/Nevermore/Firmware-Setup/)

Buying the PCB and sensors directly from Isik's Tech is strongly recommended. This project cannot provide support for third-party boards, copies, alternate producers, or other sensor modules. They may use different pin assignments, electrical designs, calibration behavior, or components and may not work as intended with these files.

## What is included

- Closed-loop fan monitoring with tachometer fault detection
- Dual synchronized SGP40 VOC readings with BME280 compensation
- Material profiles for ABS, ASA, composites, PETG, PLA, TPU, nylon, PPS, PPA, and PC
- Print filtration, adaptive post-print purge, VOC thresholds, and chamber cooling
- Interlocks for airflow, vent position, Peltier cooldown, UV, PCB temperature, and MCU temperature
- Guarded 24-hour SGP40 clean-air calibration workflow
- LED status effects through `klipper-led_effect`
- Standalone live dashboard for Mainsail or Fluidd installations
- Moonraker-managed stable updates

The shared files do not depend on someone else's `PRINT_START`, `PRINT_END`, helper macros, directory names, MCU serial, or saved-variable file. Per-printer values live in one local file that is excluded by `.gitignore`.

## Requirements

-**THIS RELEASE ASSUMES PELTIER COOLER AND UV LEDS INSTALLED.  IF YOU DO NOT HAVE THESE OPTIONAL ADDONS, DO NOT INSTALL THIS RELEASE.  THE NEXT RELEASE WILL MAKE THESE OPTIONAL.**
- A Linux Klipper host such as Raspberry Pi OS, MainsailOS, or a KIAUH installation
- Klipper, Moonraker, Git, Python 3, and `sudo`
- Nginx for the optional dashboard
- PCB v3 firmware already flashed and its USB serial path or CAN UUID available
- [`klipper-sgp40`](https://github.com/thetic/klipper-sgp40) (Klipper v0.13.0-159 or newer)
- [`klipper-led_effect`](https://github.com/julianschill/klipper-led_effect)

The installer detects the usual `~/printer_data/config` and older `~/klipper_config` layouts. Custom paths are supported with command-line options.

Before updating Klipper or Kalico, check the current compatibility notice in [Isik's firmware/software guide](https://docs.isiks.tech/Nevermore/Firmware-Setup/) and the `klipper-sgp40` project. Upstream I2C changes can temporarily break compatibility with that extension.

## Before installing this automation

First follow Isik's [official firmware and Klipper-config procedure](https://docs.isiks.tech/Nevermore/Firmware-Setup/#klipper-config) using the stock PCB v3 `SM3.cfg`. Reach a normal Klipper `ready` state and verify the following with the printer attended:

- The PCB connects reliably by the intended USB or CAN interface.
- Both BME280 and both SGP40 modules appear and report plausible values.
- The filter fan starts, stops, and reports a plausible tachometer RPM.
- The official pin mapping matches the physical connectors and wiring.
- Any optional servo, UV, Peltier, LEDs, and thermistors you intend to use are wired and tested safely.

This separates firmware, wiring, connector, sensor, and hardware faults from automation problems. Back up that working configuration. Then comment out or remove its `[include ...SM3.cfg]` line before installing this package. Do **not** load the official test config and this package at the same time; both define the same MCU, sensors, and outputs, so Klipper will report duplicate sections.

## Quick install

SSH to the printer host as the normal Klipper user. Do **not** switch to root.

Review the [installer source](https://github.com/dyocis/SM2_PCBv3_automation/blob/main/scripts/install.sh), then run:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/dyocis/SM2_PCBv3_automation/main/scripts/install.sh)"
```

After the official configuration passes those tests and its include is disabled, the installer will:

1. Find or ask for the Klipper configuration directory.
2. Clone this repository to `~/SM2_PCBv3_automation`.
3. Offer to install missing `klipper-sgp40` and `klipper-led_effect` dependencies from their official repositories.
4. Ask for the PCB v3 USB serial path or CAN UUID.
5. Create a private local hardware file and link the shared configuration files.
6. Add `[include SM2_PCBv3.cfg]` to the detected `printer.cfg`.
7. Register this repository with Moonraker's update manager.
8. Install the dashboard on port `7131` when Nginx is available.
9. Add a Mainsail navigation link when Mainsail is detected.

Existing local hardware settings are preserved when the installer is run again. Backups named `printer.cfg.before-sm2-install` and `moonraker.conf.before-sm2-install` are created before their first modification.

### Custom layout examples

Show every option:

```bash
~/SM2_PCBv3_automation/scripts/install.sh --help
```

Older/custom configuration directory:

```bash
~/SM2_PCBv3_automation/scripts/install.sh \
  --config-root /home/USER/klipper_config \
  --moonraker-config /home/USER/klipper_config/moonraker.conf
```

Custom Klipper instance and service:

```bash
~/SM2_PCBv3_automation/scripts/install.sh \
  --config-root /home/USER/printer_2_data/config \
  --klipper-path /home/USER/klipper_2 \
  --klipper-service klipper-2 \
  --klippy-venv /home/USER/klippy-env-2
```

Non-interactive USB example:

```bash
~/SM2_PCBv3_automation/scripts/install.sh --yes \
  --mcu-serial /dev/serial/by-id/REPLACE_WITH_YOUR_PCB_SERIAL
```

CAN example:

```bash
~/SM2_PCBv3_automation/scripts/install.sh \
  --canbus-uuid REPLACE_WITH_YOUR_CAN_UUID
```

`USER`, the serial value, CAN UUID, and custom paths above are placeholders. Do not paste them unchanged.

## Required configuration check

After installation, open:

```text
<your Klipper config directory>/SM2_PCBv3_automation/SM2_Local_Hardware.cfg
```

Verify all of the following against the official PCB v3 documentation and your machine:

- `[mcu SM]` USB serial path or CAN UUID
- Intake/exhaust sensor assignment (`I2C1` and `I2C2`)
- Installed addressable LED count (`chain_count`; Isik's reference config uses 16)
- Fan PWM and tachometer pins and `tachometer_ppr`
- Servo pin, open angle, and closed angle
- UV, Peltier, PCB thermistor, and LED pins
- Minimum safe fan RPM
- PCB and MCU maximum temperatures
- Peltier cooldown time

The supplied PCB v3 pin map is a starting point, not permission to skip verification. Test each output with the printer attended. Keep the Peltier and UV disconnected until fan RPM, vent direction, and emergency shutdown behavior have been confirmed.

Then run in the Mainsail/Fluidd console:

```text
FIRMWARE_RESTART
NEVERMORE_STATUS
```

If Klipper reports an error, fix it before operating the Nevermore. Do not remove an interlock merely to make an error disappear.

## Add print start and end integration

This project does not rename or replace your existing macros. Add one line to your own print-start macro:

```ini
NEVERMORE_PRINT_START FILAMENT={params.FILAMENT|default("UNKNOWN")}
```

Add one line to your own print-end macro:

```ini
NEVERMORE_PRINT_END
```

In OrcaSlicer, pass its material type into your existing start macro. Preserve the other parameters your macro already needs:

```ini
PRINT_START FILAMENT=[filament_type]
```

If you do not want to modify your wrapper macros, call the project directly in slicer start/end G-code:

```ini
NEVERMORE_PRINT_START FILAMENT=[filament_type]
```

```ini
NEVERMORE_PRINT_END
```

Hyphens and spaces are normalized. An unknown material uses a conservative fallback and does not cancel the print. Review every supplied profile before relying on its thresholds.

## Mainsail and Fluidd

The Klipper configuration is identical for both interfaces. Only dashboard navigation differs.

| Interface | Dashboard installation | Navigation behavior |
|---|---|---|
| Mainsail | Nginx serves the dashboard at `http://PRINTER_HOST:7131` | Installer merges a `Nevermore` entry into `<config>/.theme/navi.json` without replacing existing entries. Reload Mainsail after installation. |
| Fluidd | Same Nginx dashboard and URL | Installer does not modify Fluidd UI files. Open or bookmark `http://PRINTER_HOST:7131`. |

The dashboard connects to Moonraker through the local Nginx proxy and stores only the selected endpoint in that browser's local storage. Use the **Connection** button to change it. Add `?demo=1` to the URL to preview simulated states without a printer.

Custom dashboard ports are supported:

```bash
~/SM2_PCBv3_automation/scripts/install.sh --dashboard-port 7141
```

If the printer is reached by an IP address or custom hostname, set the link explicitly:

```bash
~/SM2_PCBv3_automation/scripts/install.sh --public-host 192.168.1.50
```

## SGP40 calibration

The SGP40 baseline represents the room's clean-air condition. The printer must remain unused and unheated during calibration. Clean the enclosure, remove sources of odor, provide fresh room air, and follow the sensor project's guidance before starting.

Start the guarded 24-hour workflow:

```text
NEVERMORE_SGP_CALIBRATION_START
```

The automation waits for safe temperatures and inactive outputs, resets both sensors, monitors the printer for activity, calibrates both sensors after 24 hours, and invokes `SAVE_CONFIG`. Printing, heating, Nevermore output activity, Klipper restart, or power loss invalidates the run.

Useful commands:

```text
NEVERMORE_STATUS
NEVERMORE_SGP_CALIBRATION_CANCEL
NEVERMORE_SGP_CALIBRATION_ACKNOWLEDGE
```

If the console tells you to run `FIRMWARE_RESTART`, do that before acknowledging the calibration state. Never use the BME280 reference sensors to control a heater; `klipper-sgp40` changes how their transient I2C errors are handled.

## Updates and rollback

This installer registers a `stable` Git repository updater with Moonraker. After the first tagged release, updates appear in the Mainsail or Fluidd update manager. Shared configuration and dashboard files update from Git; `SM2_Local_Hardware.cfg` and saved calibration state stay local.

Before every update:

1. Read the release notes.
2. Back up the Klipper configuration.
3. Finish or cancel any active print and SGP40 calibration.
4. Apply the update from Mainsail/Fluidd.
5. Check `FIRMWARE_RESTART`, `NEVERMORE_STATUS`, and the individual outputs while attended.

For rollback, open the repository in Moonraker's update manager and use its rollback/recover controls when offered, or use Git from SSH:

```bash
cd ~/SM2_PCBv3_automation
git fetch --tags
git checkout v0.1.0
```

Return to current stable releases with:

```bash
cd ~/SM2_PCBv3_automation
git checkout main
git pull --ff-only
```

Do not edit linked shared files on the printer; local edits make Git updates fail. Put printer-specific settings only in `SM2_Local_Hardware.cfg`.

## Uninstall

```bash
~/SM2_PCBv3_automation/scripts/uninstall.sh
```

The uninstaller removes the generated includes, shared links, dashboard server block, and Mainsail navigation entry. It preserves the local hardware file as a timestamped backup and leaves `klipper-sgp40`, `klipper-led_effect`, and saved calibration data installed.

To also remove this repository checkout:

```bash
~/SM2_PCBv3_automation/scripts/uninstall.sh --purge-repo
```

## Maintainer workflow

The recommended release path is:

1. Create a branch for one focused change.
2. Run `python3 scripts/validate_repo.py` and `bash -n scripts/*.sh`.
3. Open a pull request and let GitHub Actions validate it.
4. Merge into `main` only after testing on hardware.
5. Tag the tested commit using semantic versioning, for example `v0.1.0`.
6. Let the release workflow build the ZIP and SHA-256 checksum and publish the GitHub Release.

`main` is the public development history; tagged releases are what the `stable` Moonraker channel installs. Full first-time setup and release instructions are in [Maintainer setup](docs/MAINTAINER_SETUP.md). Change summaries belong in [CHANGELOG.md](CHANGELOG.md).

## Support boundaries

Before opening an issue, reproduce the problem using:

- The official Isik's Tech PCB v3 and BME280 + SGP40 modules linked above
- Unmodified shared files from a tagged release
- Your sanitized `SM2_Local_Hardware.cfg` values (remove MCU identifiers before sharing)
- Current Klipper/Moonraker logs and the exact console error

Community reports and pull requests are welcome, but responses and fixes are best effort. There is no guaranteed response time, maintenance window, compatibility promise, or regular release schedule. Do not report third-party Klipper extensions to the Klipper or Moonraker maintainers unless the problem also occurs without those extensions.

## License and credits

Copyright © 2026 David Yocis.

Released under the [GNU General Public License v3.0](LICENSE). The license's warranty disclaimer applies in addition to the plain-language project notice above.

This project builds on the work and documentation of:

- [Nevermore Micro / StealthMax](https://github.com/nevermore3d/Nevermore_Micro)
- [Isik's Tech Nevermore hardware](https://docs.isiks.tech/Nevermore/Controller/)
- [klipper-sgp40 by thetic](https://github.com/thetic/klipper-sgp40)
- [klipper-led_effect by julianschill](https://github.com/julianschill/klipper-led_effect)
- [Klipper](https://www.klipper3d.org/) and [Moonraker](https://moonraker.readthedocs.io/)

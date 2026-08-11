# Manual installation

Use this guide when the automatic installer cannot identify a custom layout or when you want to review every system change yourself.

The personal-project, hardware-support, responsibility, and warranty notices in the README apply here. This configuration targets only:

- [Isik's Tech StealthMax PCB v3](https://store.isiks.tech/products/nevermore-stealthmax-pcb-3)
- Two [Isik's Tech BME280 + SGP40 modules](https://store.isiks.tech/products/bme280-sgp40-air-quality-sensors-for-nevermore-air-filters)
- The [official PCB v3 wiring](https://docs.isiks.tech/Nevermore/SM3-PCB/) and [firmware setup](https://docs.isiks.tech/Nevermore/Firmware-Setup/)

Third-party boards, copies, alternate producers, and other sensor modules are unsupported and may not work as intended.

## 0. Prove the hardware with Isik's stock config

Before using any files from this repository, follow Isik's [firmware and Klipper-config instructions](https://docs.isiks.tech/Nevermore/Firmware-Setup/#klipper-config). Boot the official PCB v3 `SM3.cfg` and verify the MCU connection, all four air-quality sensors, fan command, measured RPM, pin mapping, and each optional installed output while attended.

Back up the known-working stock setup. Then disable its `[include ...SM3.cfg]` line before continuing. Never load the stock config and this package together because they define overlapping Klipper sections. If a fault occurs with the stock config, resolve the firmware, wiring, or hardware problem before testing this automation.

## 1. Define your paths

The examples use shell variables so nothing assumes MainsailOS naming. Replace each value for the printer:

```bash
SM2_CONFIG_ROOT="$HOME/printer_data/config"
SM2_KLIPPER_PATH="$HOME/klipper"
SM2_KLIPPER_SERVICE="klipper"
SM2_KLIPPY_VENV="$HOME/klippy-env"
SM2_MOONRAKER_CONFIG="$SM2_CONFIG_ROOT/moonraker.conf"
SM2_INSTALL_DIR="$HOME/SM2_PCBv3_automation"
```

Common configuration roots are `~/printer_data/config`, `~/klipper_config`, and `~/printer_2_data/config`. Confirm yours by locating the active `printer.cfg` and `moonraker.conf`; do not choose a backup directory.

## 2. Install the required Klipper extensions

SGP40 support:

```bash
cd "$HOME"
git clone https://github.com/thetic/klipper-sgp40.git
cd klipper-sgp40
./install.sh \
  -k "$SM2_KLIPPER_PATH" \
  -s "$SM2_KLIPPER_SERVICE" \
  -v "$SM2_KLIPPY_VENV"
```

LED effects:

```bash
cd "$HOME"
git clone https://github.com/julianschill/klipper-led_effect.git
cd klipper-led_effect
./install-led_effect.sh \
  -k "$SM2_KLIPPER_PATH" \
  -s "$SM2_KLIPPER_SERVICE" \
  -c "$SM2_CONFIG_ROOT"
```

Use the extension projects' current instructions if their scripts or requirements change.

## 3. Clone this project

```bash
git clone https://github.com/dyocis/SM2_PCBv3_automation.git "$SM2_INSTALL_DIR"
```

## 4. Create the local configuration directory

```bash
mkdir -p "$SM2_CONFIG_ROOT/SM2_PCBv3_automation"
cp "$SM2_INSTALL_DIR/config/SM2_Local_Hardware.cfg.example" \
  "$SM2_CONFIG_ROOT/SM2_PCBv3_automation/SM2_Local_Hardware.cfg"
chmod 600 "$SM2_CONFIG_ROOT/SM2_PCBv3_automation/SM2_Local_Hardware.cfg"
```

Edit that local file. Choose USB or CAN—never both—and verify every pin and safety value against the official board documentation and physical wiring.

## 5. Link the shared configuration

```bash
for SM2_FILE in \
  SM2_Variables.cfg \
  SM2_Hardware_Control.cfg \
  SM2_LED_Effects.cfg \
  SM2_Control.cfg \
  SM2_Material_Profiles.cfg \
  SM2_Automation.cfg; do
  ln -s "$SM2_INSTALL_DIR/config/$SM2_FILE" \
    "$SM2_CONFIG_ROOT/SM2_PCBv3_automation/$SM2_FILE"
done
```

Confirm whether the active Klipper configuration already defines `[save_variables]`:

```bash
grep -Rns '^\[save_variables\]$' "$SM2_CONFIG_ROOT" --include='*.cfg'
```

If nothing is returned, add exactly one section to a local config file:

```ini
[save_variables]
filename: /home/USER/printer_data/config/sm2_saved_variables.cfg
```

The `filename` must be an absolute path for the real Klipper user and layout. Do not create a second `[save_variables]` section when one already exists.

Create `$SM2_CONFIG_ROOT/SM2_PCBv3.cfg`:

```ini
[include SM2_PCBv3_automation/SM2_Local_Hardware.cfg]
[include SM2_PCBv3_automation/SM2_Variables.cfg]
[include SM2_PCBv3_automation/SM2_Hardware_Control.cfg]
[include SM2_PCBv3_automation/SM2_LED_Effects.cfg]
[include SM2_PCBv3_automation/SM2_Control.cfg]
[include SM2_PCBv3_automation/SM2_Material_Profiles.cfg]
[include SM2_PCBv3_automation/SM2_Automation.cfg]
```

Add this once to the active `printer.cfg`:

```ini
[include SM2_PCBv3.cfg]
```

## 6. Register updates

Add this to the active `moonraker.conf`, replacing the path with the absolute checkout path:

```ini
[update_manager SM2_PCBv3_automation]
type: git_repo
channel: stable
path: /home/USER/SM2_PCBv3_automation
origin: https://github.com/dyocis/SM2_PCBv3_automation.git
primary_branch: main
managed_services: klipper
info_tags:
  desc=Nevermore StealthMax V2 / PCB v3 automation
```

Restart Moonraker after editing. Stable updates require the repository to have at least one `vX.Y.Z` release tag.

## 7. Install the dashboard

The dashboard is optional. The automatic installer is the recommended way to create and validate its Nginx server block without replacing Mainsail/Fluidd files:

```bash
"$SM2_INSTALL_DIR/scripts/install.sh" \
  --config-root "$SM2_CONFIG_ROOT" \
  --moonraker-config "$SM2_MOONRAKER_CONFIG" \
  --skip-dependencies
```

It serves the page at `http://PRINTER_HOST:7131`. Mainsail gets a merged `.theme/navi.json` entry. Fluidd users bookmark the direct URL.

## 8. Validate before use

```bash
sudo systemctl restart moonraker
sudo systemctl restart "$SM2_KLIPPER_SERVICE"
```

Run `FIRMWARE_RESTART` and `NEVERMORE_STATUS`, then follow the attended output and interlock test sequence in the README. Do not operate the Peltier or UV until fan RPM, vent direction, and emergency shutdown behavior are verified.

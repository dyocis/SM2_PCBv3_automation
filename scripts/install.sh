#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_NAME="SM2_PCBv3_automation"
REPO_URL="https://github.com/dyocis/SM2_PCBv3_automation.git"
DEFAULT_DASHBOARD_PORT=7131
DEFAULT_MOONRAKER_PORT=7125

CONFIG_ROOT=""
MOONRAKER_CONFIG=""
INSTALL_DIR="${HOME}/${PROJECT_NAME}"
KLIPPER_PATH="${HOME}/klipper"
KLIPPER_SERVICE="klipper"
KLIPPY_VENV="${HOME}/klippy-env"
DASHBOARD_PORT="${DEFAULT_DASHBOARD_PORT}"
MOONRAKER_PORT="${DEFAULT_MOONRAKER_PORT}"
PUBLIC_HOST=""
MCU_SERIAL=""
CANBUS_UUID=""
ASSUME_YES=0
SKIP_DASHBOARD=0
SKIP_DEPENDENCIES=0
WITH_UV=-1
WITH_PELTIER=-1
WITH_VENT_SERVO=-1

log() { printf '\n[%s] %s\n' "${PROJECT_NAME}" "$*"; }
warn() { printf '\n[%s] WARNING: %s\n' "${PROJECT_NAME}" "$*" >&2; }
die() { printf '\n[%s] ERROR: %s\n' "${PROJECT_NAME}" "$*" >&2; exit 1; }

usage() {
    printf '%s\n' "Install Nevermore StealthMax V2 / Isik PCB v3 automation."
    printf '%s\n' ""
    printf '%s\n' "Usage: scripts/install.sh [options]"
    printf '%s\n' ""
    printf '%s\n' "  --config-root PATH       Klipper configuration directory"
    printf '%s\n' "  --moonraker-config PATH  moonraker.conf path"
    printf '%s\n' "  --install-dir PATH       Git checkout (default: ~/SM2_PCBv3_automation)"
    printf '%s\n' "  --klipper-path PATH      Klipper checkout (default: ~/klipper)"
    printf '%s\n' "  --klipper-service NAME   Klipper systemd service (default: klipper)"
    printf '%s\n' "  --klippy-venv PATH       Klippy virtualenv (default: ~/klippy-env)"
    printf '%s\n' "  --mcu-serial PATH        PCB USB serial-by-id path"
    printf '%s\n' "  --canbus-uuid UUID       PCB CAN UUID (instead of --mcu-serial)"
    printf '%s\n' "  --dashboard-port PORT    Dashboard HTTP port (default: 7131)"
    printf '%s\n' "  --moonraker-port PORT    Local Moonraker port (default: 7125)"
    printf '%s\n' "  --public-host HOST       Hostname/IP placed in the dashboard URL"
    printf '%s\n' "  --skip-dashboard         Do not install the Nginx dashboard"
    printf '%s\n' "  --skip-dependencies      Do not install missing Klipper extensions"
    printf '%s\n' "  --with-uv                Enable the optional UV output"
    printf '%s\n' "  --with-vent-servo        Enable the optional exhaust vent servo"
    printf '%s\n' "  --with-peltier           Enable advanced/beta Peltier support (also enables servo)"
    printf '%s\n' "  --yes                    Accept prompts (MCU address still required)"
    printf '%s\n' "  -h, --help               Show this help"
}

while (($#)); do
    case "$1" in
        --config-root) CONFIG_ROOT="${2:?missing value}"; shift 2 ;;
        --moonraker-config) MOONRAKER_CONFIG="${2:?missing value}"; shift 2 ;;
        --install-dir) INSTALL_DIR="${2:?missing value}"; shift 2 ;;
        --klipper-path) KLIPPER_PATH="${2:?missing value}"; shift 2 ;;
        --klipper-service) KLIPPER_SERVICE="${2:?missing value}"; shift 2 ;;
        --klippy-venv) KLIPPY_VENV="${2:?missing value}"; shift 2 ;;
        --mcu-serial) MCU_SERIAL="${2:?missing value}"; shift 2 ;;
        --canbus-uuid) CANBUS_UUID="${2:?missing value}"; shift 2 ;;
        --dashboard-port) DASHBOARD_PORT="${2:?missing value}"; shift 2 ;;
        --moonraker-port) MOONRAKER_PORT="${2:?missing value}"; shift 2 ;;
        --public-host) PUBLIC_HOST="${2:?missing value}"; shift 2 ;;
        --skip-dashboard) SKIP_DASHBOARD=1; shift ;;
        --skip-dependencies) SKIP_DEPENDENCIES=1; shift ;;
        --with-uv) WITH_UV=1; shift ;;
        --with-vent-servo) WITH_VENT_SERVO=1; shift ;;
        --with-peltier) WITH_PELTIER=1; WITH_VENT_SERVO=1; shift ;;
        --yes) ASSUME_YES=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "Unknown option: $1" ;;
    esac
done

[[ "${EUID}" -ne 0 ]] || die "Run this installer as your normal Klipper user, not as root. It will use sudo only where required."
[[ "${DASHBOARD_PORT}" =~ ^[0-9]+$ ]] && ((DASHBOARD_PORT >= 1024 && DASHBOARD_PORT <= 65535)) || die "Invalid dashboard port: ${DASHBOARD_PORT}"
[[ "${MOONRAKER_PORT}" =~ ^[0-9]+$ ]] && ((MOONRAKER_PORT >= 1 && MOONRAKER_PORT <= 65535)) || die "Invalid Moonraker port: ${MOONRAKER_PORT}"
[[ -z "${MCU_SERIAL}" || -z "${CANBUS_UUID}" ]] || die "Use either --mcu-serial or --canbus-uuid, not both."

confirm() {
    local prompt="$1"
    if ((ASSUME_YES)); then
        return 0
    fi
    local reply=""
    if [[ -r /dev/tty ]]; then
        read -r -p "${prompt} [y/N] " reply </dev/tty || true
    fi
    [[ "${reply}" =~ ^[Yy]$ ]]
}

choose_from() {
    local prompt="$1"
    shift
    local choices=("$@")
    ((${#choices[@]})) || return 1
    if ((${#choices[@]} == 1)); then
        printf '%s' "${choices[0]}"
        return 0
    fi
    [[ -r /dev/tty ]] || return 1
    printf '\n%s\n' "${prompt}" >/dev/tty
    local index
    for index in "${!choices[@]}"; do
        printf '  %d) %s\n' "$((index + 1))" "${choices[index]}" >/dev/tty
    done
    local selected=""
    read -r -p "Select 1-${#choices[@]}: " selected </dev/tty || return 1
    [[ "${selected}" =~ ^[0-9]+$ ]] || return 1
    ((selected >= 1 && selected <= ${#choices[@]})) || return 1
    printf '%s' "${choices[selected - 1]}"
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

require_command git
require_command python3
require_command sed

detect_config_root() {
    [[ -n "${CONFIG_ROOT}" ]] && return
    local candidates=()
    local candidate
    for candidate in \
        "${HOME}/printer_data/config" \
        "${HOME}/klipper_config" \
        "${HOME}"/*_data/config; do
        [[ -d "${candidate}" && -f "${candidate}/printer.cfg" ]] || continue
        candidates+=("${candidate}")
    done
    CONFIG_ROOT="$(choose_from "Multiple Klipper configuration directories were found:" "${candidates[@]}")" || true
    [[ -n "${CONFIG_ROOT}" ]] || die "Could not select a Klipper config directory. Re-run with --config-root PATH."
}

detect_moonraker_config() {
    [[ -n "${MOONRAKER_CONFIG}" ]] && return
    local candidates=()
    local candidate
    for candidate in \
        "${CONFIG_ROOT}/moonraker.conf" \
        "${HOME}/printer_data/config/moonraker.conf" \
        "${HOME}/klipper_config/moonraker.conf" \
        "${HOME}"/*_data/config/moonraker.conf; do
        [[ -f "${candidate}" ]] || continue
        local duplicate=0
        local existing
        for existing in "${candidates[@]:-}"; do
            [[ "${existing}" == "${candidate}" ]] && duplicate=1
        done
        ((duplicate)) || candidates+=("${candidate}")
    done
    MOONRAKER_CONFIG="$(choose_from "Multiple Moonraker configurations were found:" "${candidates[@]}")" || true
    [[ -n "${MOONRAKER_CONFIG}" ]] || warn "moonraker.conf was not found; automatic updates will not be registered."
}

checkout_project() {
    local script_dir=""
    script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P || true)"
    if [[ -n "${script_dir}" && -f "${script_dir}/../config/SM2_Variables.cfg" ]]; then
        local source_dir
        source_dir="$(cd "${script_dir}/.." && pwd -P)"
        if [[ "${source_dir}" != "${INSTALL_DIR}" ]]; then
            if [[ -e "${INSTALL_DIR}" ]]; then
                die "Install path exists and is not this checkout: ${INSTALL_DIR}"
            fi
            git clone "${REPO_URL}" "${INSTALL_DIR}"
        fi
    elif [[ ! -d "${INSTALL_DIR}/.git" ]]; then
        git clone "${REPO_URL}" "${INSTALL_DIR}"
    fi

    [[ -d "${INSTALL_DIR}/.git" ]] || die "Project checkout is not a Git repository: ${INSTALL_DIR}"
    local origin
    origin="$(git -C "${INSTALL_DIR}" remote get-url origin 2>/dev/null || true)"
    [[ "${origin}" == "${REPO_URL}" || "${origin}" == "${REPO_URL%.git}" ]] || die "Unexpected Git origin at ${INSTALL_DIR}: ${origin}"

    if [[ -n "$(git -C "${INSTALL_DIR}" status --porcelain)" ]]; then
        warn "The project checkout has local changes; leaving its current revision in place."
    else
        git -C "${INSTALL_DIR}" fetch --tags origin
        git -C "${INSTALL_DIR}" checkout main
        git -C "${INSTALL_DIR}" pull --ff-only origin main
    fi
}

install_dependency() {
    local name="$1"
    local url="$2"
    local directory="$3"
    local script="$4"
    shift 4
    if [[ ! -d "${directory}/.git" ]]; then
        git clone "${url}" "${directory}"
    else
        git -C "${directory}" pull --ff-only
    fi
    "${directory}/${script}" "$@"
    log "Installed ${name}."
}

install_dependencies() {
    ((SKIP_DEPENDENCIES == 0)) || return 0
    [[ -d "${KLIPPER_PATH}/klippy/extras" ]] || {
        warn "Klipper was not found at ${KLIPPER_PATH}; skipping dependency installation. Use --klipper-path for a custom layout."
        return
    }

    if [[ ! -e "${KLIPPER_PATH}/klippy/extras/sgp40" ]]; then
        if confirm "klipper-sgp40 is missing. Install it from thetic/klipper-sgp40?"; then
            local sgp_args=(-k "${KLIPPER_PATH}" -s "${KLIPPER_SERVICE}")
            [[ -d "${KLIPPY_VENV}" ]] && sgp_args+=(-v "${KLIPPY_VENV}")
            install_dependency "klipper-sgp40" "https://github.com/thetic/klipper-sgp40.git" "${HOME}/klipper-sgp40" "install.sh" "${sgp_args[@]}"
        else
            warn "klipper-sgp40 remains missing. Klipper cannot load the SGP40 sections until it is installed."
        fi
    fi

    if [[ ! -e "${KLIPPER_PATH}/klippy/extras/led_effect.py" ]]; then
        if confirm "klipper-led_effect is missing. Install it from julianschill/klipper-led_effect?"; then
            install_dependency "klipper-led_effect" "https://github.com/julianschill/klipper-led_effect.git" "${HOME}/klipper-led_effect" "install-led_effect.sh" -k "${KLIPPER_PATH}" -s "${KLIPPER_SERVICE}" -c "${CONFIG_ROOT}"
        else
            warn "klipper-led_effect remains missing. Klipper cannot load the LED effect sections until it is installed."
        fi
    fi
}

choose_mcu_address() {
    local local_config="$1"
    [[ ! -f "${local_config}" ]] || return 0

    if [[ -z "${MCU_SERIAL}" && -z "${CANBUS_UUID}" ]]; then
        local devices=()
        local device
        for device in /dev/serial/by-id/*; do
            [[ -e "${device}" ]] && devices+=("${device}")
        done
        if ((${#devices[@]})); then
            MCU_SERIAL="$(choose_from "Select the SM2 PCB v3 USB device. Do not select your printer's main MCU:" "${devices[@]}")" || true
        fi
    fi

    if [[ -z "${MCU_SERIAL}" && -z "${CANBUS_UUID}" && -r /dev/tty && ${ASSUME_YES} -eq 0 ]]; then
        printf '\nEnter the PCB serial-by-id path, or enter a CAN UUID prefixed with can:.\n' >/dev/tty
        local entered=""
        read -r -p "PCB address: " entered </dev/tty || true
        if [[ "${entered}" == can:* ]]; then
            CANBUS_UUID="${entered#can:}"
        else
            MCU_SERIAL="${entered}"
        fi
    fi

    [[ -n "${MCU_SERIAL}" || -n "${CANBUS_UUID}" ]] || die "A PCB address is required. Re-run with --mcu-serial PATH or --canbus-uuid UUID."
}

choose_optional_hardware() {
    if ((WITH_VENT_SERVO < 0)); then
        if ((ASSUME_YES == 0)) && confirm "Is the exhaust vent servo installed?"; then
            WITH_VENT_SERVO=1
        else
            WITH_VENT_SERVO=0
        fi
    fi

    if ((WITH_UV < 0)); then
        if ((ASSUME_YES == 0)) && confirm "Are the optional UV lights installed?"; then
            WITH_UV=1
        else
            WITH_UV=0
        fi
    fi

    if ((WITH_PELTIER < 0)); then
        if ((ASSUME_YES == 0)) && confirm "Is the advanced/beta Peltier add-on installed?"; then
            WITH_PELTIER=1
        else
            WITH_PELTIER=0
        fi
    fi

    if ((WITH_PELTIER)); then
        WITH_VENT_SERVO=1
        warn "Peltier support is advanced/beta and requires the exhaust vent servo. Servo support has been enabled."
        warn "This release does not configure or monitor Peltier hot-side/cold-side thermistors; that protection is planned for a future release."
        if ((ASSUME_YES == 0)); then
            confirm "I understand the current Peltier thermistor limitation; continue?" || die "Installation cancelled."
        fi
    fi
}

enable_optional_block() {
    local config_file="$1"
    local feature="$2"
    local begin="# SM2_OPTION_${feature}_BEGIN"
    local end="# SM2_OPTION_${feature}_END"

    grep -Fqs "${begin}" "${config_file}" || die "Optional hardware marker missing: ${begin}"
    grep -Fqs "${end}" "${config_file}" || die "Optional hardware marker missing: ${end}"
    sed -i "/^${begin}$/,/^${end}$/ s/^#? //" "${config_file}"
}

write_local_config() {
    local target_dir="${CONFIG_ROOT}/${PROJECT_NAME}"
    local local_config="${target_dir}/SM2_Local_Hardware.cfg"
    mkdir -p "${target_dir}"
    choose_mcu_address "${local_config}"

    if [[ ! -f "${local_config}" ]]; then
        choose_optional_hardware
        cp "${INSTALL_DIR}/config/SM2_Local_Hardware.cfg.example" "${local_config}"
        if [[ -n "${CANBUS_UUID}" ]]; then
            sed -i "s|^serial: .*|# serial: /dev/serial/by-id/REPLACE_WITH_YOUR_PCB_SERIAL|" "${local_config}"
            sed -i "s|^# canbus_uuid: .*|canbus_uuid: ${CANBUS_UUID}|" "${local_config}"
        else
            sed -i "s|^serial: .*|serial: ${MCU_SERIAL}|" "${local_config}"
        fi
        ((WITH_VENT_SERVO == 0)) || enable_optional_block "${local_config}" "VENT"
        ((WITH_UV == 0)) || enable_optional_block "${local_config}" "UV"
        ((WITH_PELTIER == 0)) || enable_optional_block "${local_config}" "PELTIER"
        chmod 600 "${local_config}"
        log "Created local hardware configuration: ${local_config}"
        log "Optional hardware: servo=$([[ ${WITH_VENT_SERVO} -eq 1 ]] && printf installed || printf absent), UV=$([[ ${WITH_UV} -eq 1 ]] && printf installed || printf absent), Peltier=$([[ ${WITH_PELTIER} -eq 1 ]] && printf installed || printf absent)"
    else
        log "Preserved existing local hardware configuration: ${local_config}"
        local configured_optional=()
        grep -qsE '^[[:space:]]*\[servo[[:space:]]+SM_Vent\][[:space:]]*$' "${local_config}" && configured_optional+=("servo")
        grep -qsE '^[[:space:]]*\[output_pin[[:space:]]+uv\][[:space:]]*$' "${local_config}" && configured_optional+=("UV")
        grep -qsE '^[[:space:]]*\[output_pin[[:space:]]+peltier\][[:space:]]*$' "${local_config}" && configured_optional+=("Peltier")
        if ((${#configured_optional[@]})); then
            log "Configured optional hardware in the preserved file: ${configured_optional[*]}"
        else
            log "Configured optional hardware in the preserved file: none"
        fi
        warn "Verify the configured optional sections match the hardware physically installed before restarting Klipper."
        if ((WITH_UV >= 0 || WITH_PELTIER >= 0 || WITH_VENT_SERVO >= 0)); then
            warn "Optional-hardware flags apply only when creating a new local hardware file. Edit ${local_config} to change an existing installation."
        fi
    fi

    local shared
    for shared in \
        SM2_Variables.cfg \
        SM2_Hardware_Control.cfg \
        SM2_LED_Effects.cfg \
        SM2_Control.cfg \
        SM2_Material_Profiles.cfg \
        SM2_Automation.cfg; do
        ln -sfn "${INSTALL_DIR}/config/${shared}" "${target_dir}/${shared}"
    done

    local save_include=""
    rm -f "${target_dir}/SM2_Save_Variables.cfg"
    if grep -RqsE '^[[:space:]]*\[save_variables\][[:space:]]*$' "${CONFIG_ROOT}" --include='*.cfg'; then
        :
    else
        printf '[save_variables]\nfilename: %s/sm2_saved_variables.cfg\n' "${CONFIG_ROOT}" >"${target_dir}/SM2_Save_Variables.cfg"
        save_include="[include ${PROJECT_NAME}/SM2_Save_Variables.cfg]"
    fi

    local aggregator="${CONFIG_ROOT}/SM2_PCBv3.cfg"
    local temporary
    temporary="$(mktemp "${CONFIG_ROOT}/.sm2-aggregator.XXXXXX")"
    {
        printf '# Managed by %s/scripts/install.sh\n' "${PROJECT_NAME}"
        printf '# Put printer-specific changes in %s/SM2_Local_Hardware.cfg.\n\n' "${PROJECT_NAME}"
        printf '[include %s/SM2_Local_Hardware.cfg]\n' "${PROJECT_NAME}"
        [[ -z "${save_include}" ]] || printf '%s\n' "${save_include}"
        printf '[include %s/SM2_Variables.cfg]\n' "${PROJECT_NAME}"
        printf '[include %s/SM2_Hardware_Control.cfg]\n' "${PROJECT_NAME}"
        printf '[include %s/SM2_LED_Effects.cfg]\n' "${PROJECT_NAME}"
        printf '[include %s/SM2_Control.cfg]\n' "${PROJECT_NAME}"
        printf '[include %s/SM2_Material_Profiles.cfg]\n' "${PROJECT_NAME}"
        printf '[include %s/SM2_Automation.cfg]\n' "${PROJECT_NAME}"
    } >"${temporary}"
    mv "${temporary}" "${aggregator}"

    local printer_config="${CONFIG_ROOT}/printer.cfg"
    if ! grep -qsE '^[[:space:]]*\[include[[:space:]]+SM2_PCBv3\.cfg\][[:space:]]*$' "${printer_config}"; then
        cp -p "${printer_config}" "${printer_config}.before-sm2-install"
        printf '\n# Nevermore StealthMax V2 / PCB v3 automation\n[include SM2_PCBv3.cfg]\n' >>"${printer_config}"
        log "Added [include SM2_PCBv3.cfg] to printer.cfg."
    fi
}

write_moonraker_updater() {
    [[ -n "${MOONRAKER_CONFIG}" ]] || return 0
    local target_dir="${CONFIG_ROOT}/${PROJECT_NAME}"
    local updater="${target_dir}/moonraker_update.conf"
    rm -f "${updater}"
    local add_sgp40_updater=0
    if [[ -d "${HOME}/klipper-sgp40/.git" ]] \
        && ! grep -RqsE '^[[:space:]]*\[update_manager[[:space:]]+klipper-sgp40\][[:space:]]*$' "${CONFIG_ROOT}" --include='*.conf'; then
        add_sgp40_updater=1
    fi
    {
        printf '[update_manager %s]\n' "${PROJECT_NAME}"
        printf 'type: git_repo\n'
        printf 'channel: stable\n'
        printf 'path: %s\n' "${INSTALL_DIR}"
        printf 'origin: %s\n' "${REPO_URL}"
        printf 'primary_branch: main\n'
        printf 'managed_services: klipper\n'
        printf 'info_tags:\n'
        printf '  desc=Nevermore StealthMax V2 / PCB v3 automation\n'
        if ((add_sgp40_updater)); then
            printf '\n[update_manager klipper-sgp40]\n'
            printf 'type: git_repo\n'
            printf 'path: %s/klipper-sgp40\n' "${HOME}"
            printf 'origin: https://github.com/thetic/klipper-sgp40.git\n'
            printf 'primary_branch: main\n'
            printf 'managed_services: klipper\n'
        fi
    } >"${updater}"

    local include="[include ${PROJECT_NAME}/moonraker_update.conf]"
    if ! grep -Fqs "${include}" "${MOONRAKER_CONFIG}"; then
        cp -p "${MOONRAKER_CONFIG}" "${MOONRAKER_CONFIG}.before-sm2-install"
        printf '\n# Nevermore StealthMax V2 / PCB v3 updates\n%s\n' "${include}" >>"${MOONRAKER_CONFIG}"
    fi
}

install_dashboard() {
    ((SKIP_DASHBOARD == 0)) || return 0
    if ! command -v nginx >/dev/null 2>&1; then
        warn "Nginx is not installed; skipping the dashboard. Re-run after installing Nginx."
        return
    fi
    command -v sudo >/dev/null 2>&1 || {
        warn "sudo is unavailable; skipping the dashboard."
        return
    }
    if ! sudo -v; then
        warn "sudo authorization failed; skipping the dashboard."
        return 0
    fi

    local nginx_user="www-data"
    if [[ -r /etc/nginx/nginx.conf ]]; then
        nginx_user="$(awk '$1 == "user" {gsub(/;/, "", $2); print $2; exit}' /etc/nginx/nginx.conf)"
        nginx_user="${nginx_user:-www-data}"
    fi
    if ! sudo -u "${nginx_user}" test -r "${INSTALL_DIR}/dashboard/index.html"; then
        warn "Nginx user '${nginx_user}' cannot read ${INSTALL_DIR}/dashboard. Fix directory traversal permissions or use --skip-dashboard."
        return 0
    fi

    local nginx_config="/etc/nginx/conf.d/sm2-pcbv3-dashboard.conf"
    local nginx_temp
    local nginx_backup=""
    nginx_temp="$(mktemp)"
    {
        printf 'server {\n'
        printf '    listen %s;\n' "${DASHBOARD_PORT}"
        printf '    listen [::]:%s;\n' "${DASHBOARD_PORT}"
        printf '    server_name _;\n\n'
        printf '    root %s/dashboard;\n' "${INSTALL_DIR}"
        printf '    index index.html;\n\n'
        printf '    location / {\n'
        printf '        try_files $uri $uri/ /index.html;\n'
        printf '        add_header Cache-Control "no-cache";\n'
        printf '    }\n\n'
        printf '    location /websocket {\n'
        printf '        proxy_pass http://127.0.0.1:%s/websocket;\n' "${MOONRAKER_PORT}"
        printf '        proxy_http_version 1.1;\n'
        printf '        proxy_set_header Upgrade $http_upgrade;\n'
        printf '        proxy_set_header Connection "upgrade";\n'
        printf '        proxy_set_header Host $host;\n'
        printf '        proxy_set_header X-Real-IP $remote_addr;\n'
        printf '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
        printf '        proxy_read_timeout 86400;\n'
        printf '    }\n'
        printf '}\n'
    } >"${nginx_temp}"

    if sudo test -f "${nginx_config}"; then
        nginx_backup="$(mktemp)"
        sudo cp "${nginx_config}" "${nginx_backup}"
    fi
    sudo install -m 0644 "${nginx_temp}" "${nginx_config}"
    rm -f "${nginx_temp}"
    if ! sudo nginx -t; then
        if [[ -n "${nginx_backup}" ]]; then
            sudo install -m 0644 "${nginx_backup}" "${nginx_config}"
        else
            sudo rm -f "${nginx_config}"
        fi
        rm -f "${nginx_backup}"
        die "Nginx rejected the dashboard configuration; the previous state was restored."
    fi
    [[ -z "${nginx_backup}" ]] || rm -f "${nginx_backup}"
    sudo systemctl reload nginx

    if [[ -z "${PUBLIC_HOST}" ]]; then
        PUBLIC_HOST="$(hostname -s).local"
    fi
    local dashboard_url="http://${PUBLIC_HOST}:${DASHBOARD_PORT}"

    if [[ -d "${HOME}/mainsail" || -d "${CONFIG_ROOT}/.theme" ]]; then
        mkdir -p "${CONFIG_ROOT}/.theme"
        if [[ -f "${CONFIG_ROOT}/.theme/navi.json" && ! -f "${CONFIG_ROOT}/.theme/navi.json.before-sm2-install" ]]; then
            cp -p "${CONFIG_ROOT}/.theme/navi.json" "${CONFIG_ROOT}/.theme/navi.json.before-sm2-install"
        fi
        if python3 - "${CONFIG_ROOT}/.theme/navi.json" "${dashboard_url}" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
href = sys.argv[2]
try:
    entries = json.loads(path.read_text()) if path.exists() else []
except (json.JSONDecodeError, OSError) as exc:
    raise SystemExit(f"Cannot safely update {path}: {exc}")
if not isinstance(entries, list):
    raise SystemExit(f"Cannot safely update {path}: root must be a JSON array")
entry = {"title": "Nevermore", "href": href, "target": "_blank", "position": 85}
entries = [item for item in entries if not (isinstance(item, dict) and item.get("title") == "Nevermore")]
entries.append(entry)
path.write_text(json.dumps(entries, indent=2) + "\n")
PY
        then
            log "Added the Nevermore dashboard to Mainsail custom navigation."
        else
            warn "Mainsail navi.json could not be updated safely. Use the direct dashboard URL below."
        fi
    elif [[ -d "${HOME}/fluidd" ]]; then
        log "Fluidd detected. Its stable UI has no equivalent navi.json integration; bookmark the dashboard URL below."
    fi

    log "Dashboard: ${dashboard_url}"
}

restart_services() {
    if command -v systemctl >/dev/null 2>&1; then
        sudo systemctl restart moonraker 2>/dev/null || warn "Could not restart Moonraker automatically. Restart it from your UI or with systemctl."
        sudo systemctl restart "${KLIPPER_SERVICE}" 2>/dev/null || warn "Could not restart ${KLIPPER_SERVICE}. Restart Klipper after checking the local hardware file."
    fi
}

main() {
    log "Personal project notice: this software is provided as-is, without a promised update schedule. You are responsible for your printer, wiring, configuration, and installed software."
    printf '%s\n' "Supported hardware: official Isik's Tech StealthMax PCB v3 and BME280 + SGP40 modules."
    printf '%s\n' "PCB:     https://store.isiks.tech/products/nevermore-stealthmax-pcb-3"
    printf '%s\n' "Sensors: https://store.isiks.tech/products/bme280-sgp40-air-quality-sensors-for-nevermore-air-filters"
    printf '%s\n' "Third-party boards and alternate sensor modules are not supported and may not work as intended."
    printf '%s\n' "Before continuing, boot and test Isik's official SM3.cfg, then disable its [include] line."
    printf '%s\n' "Guide:   https://docs.isiks.tech/Nevermore/Firmware-Setup/#klipper-config"
    printf '%s\n' "Do not load the official test config and this package at the same time; their Klipper sections overlap."
    confirm "Official hardware config tested and its include disabled; continue?" || die "Installation cancelled."
    detect_config_root
    detect_moonraker_config
    checkout_project
    install_dependencies
    write_local_config
    write_moonraker_updater
    install_dashboard
    restart_services

    log "Installation complete."
    printf '%s\n' "Local hardware file: ${CONFIG_ROOT}/${PROJECT_NAME}/SM2_Local_Hardware.cfg"
    printf '%s\n' "Klipper include:      ${CONFIG_ROOT}/SM2_PCBv3.cfg"
    printf '%s\n' "Next: open the hardware file, verify every pin/address and safety value, then run FIRMWARE_RESTART."
    printf '%s\n' "Test outputs individually before leaving the printer unattended."
}

main

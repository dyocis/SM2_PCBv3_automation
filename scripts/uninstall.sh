#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_NAME="SM2_PCBv3_automation"
CONFIG_ROOT=""
MOONRAKER_CONFIG=""
INSTALL_DIR="${HOME}/${PROJECT_NAME}"
PURGE_REPO=0
ASSUME_YES=0

log() { printf '\n[%s] %s\n' "${PROJECT_NAME}" "$*"; }
warn() { printf '\n[%s] WARNING: %s\n' "${PROJECT_NAME}" "$*" >&2; }
die() { printf '\n[%s] ERROR: %s\n' "${PROJECT_NAME}" "$*" >&2; exit 1; }

usage() {
    printf '%s\n' "Usage: scripts/uninstall.sh [options]"
    printf '%s\n' "  --config-root PATH       Klipper configuration directory"
    printf '%s\n' "  --moonraker-config PATH  moonraker.conf path"
    printf '%s\n' "  --install-dir PATH       Git checkout (default: ~/SM2_PCBv3_automation)"
    printf '%s\n' "  --purge-repo             Also delete the project Git checkout"
    printf '%s\n' "  --yes                    Skip confirmation"
    printf '%s\n' "  -h, --help               Show this help"
}

while (($#)); do
    case "$1" in
        --config-root) CONFIG_ROOT="${2:?missing value}"; shift 2 ;;
        --moonraker-config) MOONRAKER_CONFIG="${2:?missing value}"; shift 2 ;;
        --install-dir) INSTALL_DIR="${2:?missing value}"; shift 2 ;;
        --purge-repo) PURGE_REPO=1; shift ;;
        --yes) ASSUME_YES=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "Unknown option: $1" ;;
    esac
done

if [[ -z "${CONFIG_ROOT}" ]]; then
    for candidate in "${HOME}/printer_data/config" "${HOME}/klipper_config" "${HOME}"/*_data/config; do
        if [[ -f "${candidate}/SM2_PCBv3.cfg" ]]; then
            CONFIG_ROOT="${candidate}"
            break
        fi
    done
fi
[[ -n "${CONFIG_ROOT}" && -d "${CONFIG_ROOT}" ]] || die "Installation not found. Re-run with --config-root PATH."

if [[ -z "${MOONRAKER_CONFIG}" && -f "${CONFIG_ROOT}/moonraker.conf" ]]; then
    MOONRAKER_CONFIG="${CONFIG_ROOT}/moonraker.conf"
fi

if ((ASSUME_YES == 0)); then
    reply=""
    [[ -r /dev/tty ]] && read -r -p "Remove SM2 PCB v3 automation from ${CONFIG_ROOT}? [y/N] " reply </dev/tty || true
    [[ "${reply}" =~ ^[Yy]$ ]] || die "Uninstall cancelled."
fi

remove_include_block() {
    local file="$1"
    local include_pattern="$2"
    [[ -f "${file}" ]] || return 0
    local temporary
    temporary="$(mktemp "${file}.XXXXXX")"
    awk -v include_pattern="${include_pattern}" '
        $0 == include_pattern { next }
        $0 == "# Nevermore StealthMax V2 / PCB v3 automation" { next }
        $0 == "# Nevermore StealthMax V2 / PCB v3 updates" { next }
        { print }
    ' "${file}" >"${temporary}"
    mv "${temporary}" "${file}"
}

remove_include_block "${CONFIG_ROOT}/printer.cfg" "[include SM2_PCBv3.cfg]"
if [[ -n "${MOONRAKER_CONFIG}" ]]; then
    remove_include_block "${MOONRAKER_CONFIG}" "[include ${PROJECT_NAME}/moonraker_update.conf]"
fi

rm -f "${CONFIG_ROOT}/SM2_PCBv3.cfg"
target_dir="${CONFIG_ROOT}/${PROJECT_NAME}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -f "${target_dir}/SM2_Local_Hardware.cfg" ]]; then
    backup="${CONFIG_ROOT}/SM2_Local_Hardware.cfg.uninstalled-${timestamp}"
    mv "${target_dir}/SM2_Local_Hardware.cfg" "${backup}"
    chmod 600 "${backup}"
    log "Preserved local hardware settings at ${backup}"
fi

for file in \
    SM2_Variables.cfg \
    SM2_Hardware_Control.cfg \
    SM2_LED_Effects.cfg \
    SM2_Control.cfg \
    SM2_Material_Profiles.cfg \
    SM2_Automation.cfg \
    SM2_Save_Variables.cfg \
    moonraker_update.conf; do
    rm -f "${target_dir}/${file}"
done
rmdir "${target_dir}" 2>/dev/null || warn "Kept non-project files in ${target_dir}."

if [[ -f "${CONFIG_ROOT}/.theme/navi.json" ]]; then
    if ! python3 - "${CONFIG_ROOT}/.theme/navi.json" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
entries = json.loads(path.read_text())
if isinstance(entries, list):
    entries = [item for item in entries if not (isinstance(item, dict) and item.get("title") == "Nevermore")]
    path.write_text(json.dumps(entries, indent=2) + "\n")
PY
    then
        warn "Could not remove the Mainsail navigation entry safely; edit ${CONFIG_ROOT}/.theme/navi.json manually."
    fi
fi

if command -v sudo >/dev/null 2>&1 && sudo -v; then
    sudo rm -f /etc/nginx/conf.d/sm2-pcbv3-dashboard.conf
    if command -v nginx >/dev/null 2>&1 && sudo nginx -t; then
        sudo systemctl reload nginx || true
    fi
    sudo systemctl restart moonraker 2>/dev/null || true
    sudo systemctl restart klipper 2>/dev/null || true
else
    warn "sudo authorization was unavailable; remove /etc/nginx/conf.d/sm2-pcbv3-dashboard.conf manually if it exists."
fi

if ((PURGE_REPO)); then
    resolved_install="$(realpath -m "${INSTALL_DIR}")"
    expected_install="$(realpath -m "${HOME}/${PROJECT_NAME}")"
    [[ "${resolved_install}" == "${expected_install}" ]] || die "Refusing to delete unexpected path: ${resolved_install}"
    [[ -d "${resolved_install}/.git" ]] || die "Refusing to delete a path that is not the project Git checkout: ${resolved_install}"
    rm -rf -- "${resolved_install}"
    log "Deleted project checkout: ${resolved_install}"
fi

log "Uninstall complete. klipper-sgp40, klipper-led_effect, and saved calibration data were left in place."

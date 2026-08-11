# Contributing

Thank you for helping improve this personal, best-effort project. There is no guaranteed response or merge schedule.

## Before reporting a problem

Use the official Isik's Tech StealthMax PCB v3 and BME280 + SGP40 modules linked in the README. Third-party boards, copies, alternate sensor modules, and other hardware are outside this project's support scope.

Confirm the problem on a tagged release with unmodified shared files. Check your local pin map, wiring, Klipper log, and Moonraker log. Remove MCU serials, CAN UUIDs, network credentials, API keys, and other private values before posting.

## Pull requests

1. Create a focused branch from `development` and target `development` with the pull request.
2. Keep printer-specific data out of the shared files.
3. Update the README and changelog when behavior changes.
4. Run:

   ```bash
   bash -n scripts/*.sh
   node --check dashboard/app.js
   python3 scripts/validate_repo.py
   ```

5. Explain the hardware used, checks performed, safety impact, and rollback path in the pull request.

Changes affecting UV, Peltier, fan, vent, temperature, or calibration interlocks must be tested attended on the official hardware before release.

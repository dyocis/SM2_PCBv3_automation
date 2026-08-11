# Maintainer setup and release workflow

This guide is for the owner of `dyocis/SM2_PCBv3_automation`. It assumes little or no prior GitHub release experience.

This remains a personal, best-effort project. A clean workflow makes updates safer and easier to publish; it does not create an obligation to release on a schedule.

## Current branch and release model

| Ref | Purpose |
|---|---|
| `main` | Stable installation branch; currently `v0.1.0` behavior plus repository-maintenance fixes |
| `develop` | Unreleased next-version work; currently the optional-hardware candidate planned for `v0.2.0` |
| `vX.Y.Z` tags | Immutable public releases and the source for GitHub Release archives |

Create normal feature and fix branches from `develop`, and merge them back into `develop`. Merge `develop` into `main` only after the complete candidate has passed validation and attended hardware testing. Tag the tested `main` commit immediately after that release merge.

## 1. Create the repository

The repository has already been created at:

<https://github.com/dyocis/SM2_PCBv3_automation>

For GitHub's initialization choices, use:

| GitHub option | Choice | Reason |
|---|---|---|
| Visibility | Public | Required for the public installer URL and community access |
| Add a README | No | This package supplies `README.md` |
| Add `.gitignore` | **None** | This package supplies a project-specific `.gitignore` |
| License | None in the creation screen | This package supplies the complete GPL-3.0 `LICENSE` file |

The correct filename is `.gitignore` (not `.gotignore`). It intentionally excludes local MCU addresses, saved variables, logs, editor files, and generated release archives.

## 2. Make the initial upload

Extract the prepared repository package. In a terminal, change to the directory containing `README.md`, then run:

```bash
git init -b main
git remote add origin https://github.com/dyocis/SM2_PCBv3_automation.git
git add .
git status
git commit -m "Initial public release"
git push -u origin main
```

Read the `git status` output before committing. It should show the public project files and must not show `SM2_Local_Hardware.cfg`, printer logs, `variables.cfg`, API keys, passwords, a real `/dev/serial/by-id/...` value, or a CAN UUID.

If Git asks who you are, set your author identity and repeat the commit:

```bash
git config --global user.name "David Yocis"
git config --global user.email "YOUR_GITHUB_EMAIL"
```

If GitHub asks for authentication, use GitHub's browser/device login or a personal access token. GitHub account passwords are not accepted for Git pushes.

## 3. Confirm the first validation run

Open the repository's **Actions** tab. The `Validate` workflow should run after the push and check:

- Shell syntax
- Dashboard JavaScript syntax
- Required files
- Local/private identifier patterns
- Klipper custom macro and delayed-G-code references
- Dashboard HTML/JavaScript element matching

Do not tag the first release until this workflow passes and the files have been tested on the intended hardware.

## 4. Configure GitHub Actions for releases

Open **Settings → Actions → General**.

Under **Workflow permissions**, select **Read and write permissions** if your account or organization defaults to read-only, then save. The release workflow needs permission to create a GitHub Release and upload its ZIP and checksum. It does not require a personal token stored in repository secrets.

If the repository is under an organization later, organization policy may override this setting.

## 5. Set repository details

On the repository home page, use the **About** gear and add:

- Description: `Klipper automation and dashboard for Nevermore StealthMax V2 with Isik PCB v3`
- Website: `https://docs.isiks.tech/Nevermore/Controller/`
- Topics: `klipper`, `nevermore`, `stealthmax`, `voron`, `moonraker`, `mainsail`, `fluidd`, `sgp40`

In **Settings → General → Features**, enable Issues if you want public reports. In **Settings → Code security and analysis**, enable private vulnerability reporting if available.

## 6. Existing first release

`v0.1.0` has already been published. Do not recreate, move, or reuse that tag. Its release notes warn that the configuration requires the Peltier cooler, UV LEDs, and exhaust servo.

For future releases, Moonraker's `stable` Git updater requires a semantic version tag. After validation and hardware testing are complete, merge `develop` into `main`, verify the exact commit, and create the next tag. For the optional-hardware release, that tag is expected to be `v0.2.0`:

```bash
git checkout develop
git pull --ff-only
git checkout main
git pull --ff-only
git merge --ff-only develop
git tag -a v0.2.0 -m "Release v0.2.0"
git push origin main v0.2.0
```

The `Release` workflow will:

1. Re-run validation.
2. Build a versioned ZIP from the tagged commit.
3. Generate `SHA256SUMS`.
4. Create the GitHub Release with generated notes.

Open **Actions** and confirm the release job passes. Then open **Releases** and edit the generated notes if they need clearer safety, upgrade, or rollback instructions.

## 7. Protect `main` after the first release

Do this after the initial commit and tag so the empty repository does not block its own setup.

Open **Settings → Rules → Rulesets** and create a branch ruleset targeting `main`:

- Require a pull request before merging
- Require status checks to pass
- Select the validation check after it has run at least once
- Block force pushes
- Block branch deletion

For a one-person project, one approving review is optional; requiring it can prevent you from merging your own maintenance work. The status check and no-force-push rules provide the most value here.

## Normal development workflow

Never develop a change directly on a printer's installed `main` checkout. Work in a separate local clone and keep unreleased changes on `develop` or a branch created from it.

### 1. Start a branch

```bash
git checkout develop
git pull --ff-only
git checkout -b feature/short-description
```

Use `fix/...`, `docs/...`, or `feature/...` names that describe one focused change.

### 2. Make and validate the change

```bash
bash -n scripts/*.sh
node --check dashboard/app.js
python3 scripts/validate_repo.py
```

For config changes, test an attended printer in this order:

1. Klipper parses and reaches `ready` after `FIRMWARE_RESTART`.
2. Sensor names, temperature, humidity, and VOC values are plausible.
3. Fan command and measured RPM agree.
4. Vent open/close direction and angles are correct.
5. UV refuses unsafe operation and turns off on fault.
6. Peltier waits for a closed vent and verified airflow.
7. Peltier cooldown preserves fan airflow for the configured duration.
8. PCB/MCU over-temperature and low-RPM paths de-energize outputs.
9. Print start/end and material selection behave correctly.
10. Dashboard and calibration maintenance states render correctly.

Never shorten or bypass physical-safety tests to meet a release date.

### 3. Commit and push

```bash
git add .
git status
git commit -m "Describe the change"
git push -u origin feature/short-description
```

### 4. Open a pull request

On GitHub, choose **Compare & pull request** and set the base branch to `develop`. Explain:

- What changed and why
- Which official hardware was used
- Exactly what was tested
- Safety behavior affected
- Upgrade instructions, if any
- Rollback path

Wait for `Validate` to pass, review the diff, then squash-merge or merge the pull request into `develop`.

### 5. Decide whether to release

Not every change merged into `develop` needs an immediate release. Publish when a tested set of changes is useful. Update `CHANGELOG.md`, complete attended hardware testing, then choose the next version:

| Change | Example | Version action |
|---|---|---|
| Backward-compatible fix | Dashboard display correction | `v0.1.0` → `v0.1.1` |
| Backward-compatible feature | New profile or optional installer flag | `v0.1.0` → `v0.2.0` |
| Breaking config/hardware behavior | Renamed public macros or incompatible local config | `v0.2.0` → `v1.0.0` or next major |

Merge the tested candidate to `main`, then create and push the annotated tag:

```bash
git checkout develop
git pull --ff-only
git checkout main
git pull --ff-only
git merge --ff-only develop
git tag -a v0.1.1 -m "Release v0.1.1"
git push origin main v0.1.1
```

## Correcting a bad release

Do not move or reuse a published tag. That makes installed versions ambiguous.

1. Identify the last known-good tag.
2. If the current release presents a hardware risk, edit its GitHub Release notes immediately with a prominent warning.
3. Revert the bad commit on a new branch, validate and test it, and merge the pull request.
4. Publish a new patch tag, such as `v0.1.2`.
5. Explain the affected versions, safe state, fix, and rollback command in the release notes.

Users can pin a known-good version with:

```bash
cd ~/SM2_PCBv3_automation
git fetch --tags
git checkout v0.1.1
```

They return to normal stable tracking with:

```bash
git checkout main
git pull --ff-only
```

## Files that must remain local

Never commit:

- `SM2_Local_Hardware.cfg`
- Real USB serial paths or CAN UUIDs
- `variables.cfg` or `sm2_saved_variables.cfg`
- Klipper/Moonraker logs
- Network credentials, API keys, passwords, or `.env` files
- Backups of a complete printer configuration

The repository validator catches common patterns, but it is not a substitute for reading the staged diff before every push.

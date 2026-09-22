# ChatGPT / Codex Desktop Flatpak

This repo packages the **official** ChatGPT / Codex Linux build as a Flatpak
that starts with no access to your files, and gives it back one directory at a
time. Codex executes code. This exists so the thing running commands cannot
read `~/.ssh`, `~/.aws`, your browser profiles or your work repos unless you
say so.

**It trades ease of use for that, and the trade is real.** You configure what it
can see, the desktop avatar does not render, and it is not on your `PATH`. If
you want the app rather than the confinement, install it on the host instead.
On Bluefin, Bazzite and Aurora that is one command, it updates itself, and there
is nothing to configure:

```sh
brew install --cask ublue-os/experimental-tap/chatgpt-linux
```

That unpacks OpenAI's rpm into `~/.local` and runs it as you, with your full
user rights. For most people that is the right answer. Everything below is for
the people it is not.

## Install

```sh
flatpak remote-add --user chatgpt https://vivienm.github.io/chatgpt-flatpak/chatgpt.flatpakrepo
flatpak install --user chatgpt io.github.vivienm.ChatGPT
```

The app starts with **no access to your files.** Grant a directory explicitly,
for example your Desktop:

```sh
flatpak override --user --filesystem=~/Desktop io.github.vivienm.ChatGPT
```

### Project access

Grant each project you want Codex to use as a persistent, narrow filesystem
permission. For example:

```sh
flatpak override --user \
  --filesystem=~/code/my-project \
  io.github.vivienm.ChatGPT
```

Then open the project in the app using its stable path, such as
`~/code/my-project`. A directory selected through the desktop file picker may
instead appear inside the sandbox as `/run/flatpak/doc/...`. That document
portal path can disappear or become stale after the app restarts. Existing
tasks may then report `getcwd` or `Git is unavailable`, and the integrated
terminal can briefly open and immediately close.

This does **not** require `--filesystem=host` or access to your whole home
directory. Grant only the repository (or the smallest parent directory you
actually want the app to use). Revoke a project grant with:

```sh
flatpak override --user \
  --nofilesystem=~/code/my-project \
  io.github.vivienm.ChatGPT
```

Also published as an OCI image at `ghcr.io/vivienm/chatgpt-flatpak`, for
mirroring and offline installs. Fetch it with a registry client first: pointing
flatpak straight at `docker://` returns 401, because it does not complete the
anonymous token exchange GHCR requires, even though the package is public.

```sh
skopeo copy docker://ghcr.io/vivienm/chatgpt-flatpak:latest oci:oci-chatgpt:latest
flatpak install --user --image oci:oci-chatgpt:latest
```

That image is 3 MB. It carries the packaging alone; the application itself is
still downloaded from OpenAI at install time, exactly as with the repo above.

## Sandbox

Sealed by default: no `--filesystem=host`, no
`--talk-name=org.freedesktop.Flatpak`. The app cannot read your home directory
or run commands on your host until you grant it.

Renderers stay isolated under zypak rather than `--no-sandbox`, which is what
the other Flatpak repackagings of this app use. `--no-sandbox` does not disable
"a" sandbox, it removes renderer isolation entirely, so any compromised web
content inherits every permission the flatpak holds.

Codex command execution uses Flatpak itself as the outer sandbox. Flatpak
prevents Codex from creating its normal nested `bwrap` user namespace, so this
package wraps the bundled Codex executable with
`--dangerously-bypass-approvals-and-sandbox`. Despite the flag's name, commands
do not gain host access: they get only what the Flatpak can already see, including
directories you explicitly grant, app-persistent data, network access, runtime
tools, and allowed D-Bus services. They cannot read arbitrary host files or run
host commands. Chromium renderer isolation under zypak is unchanged. See
[docs/SECURITY.md](docs/SECURITY.md) for the full tradeoff.

This fork requires **Wayland**. The launcher selects native Wayland explicitly;
the package denies both X11 sockets and the host IPC namespace. An X11-only
session is unsupported. Existing user overrides can still widen permissions.
Network access remains enabled, including access to host abstract Unix sockets;
removing the X11 socket grants does not isolate those endpoints. See
[docs/SECURITY.md](docs/SECURITY.md) for this limitation.

Credential storage uses Electron's **local `basic` backend**. No direct access
to Secret Service / GNOME Keyring or KWallet is granted. This reduces exposure
of the host's other secrets, but credentials in the app's private data must be
treated as plaintext. Disk encryption protects them while the volume is locked;
it does not protect a copy of those files or an unencrypted backup. Switching
from a keyring-backed installation may require signing in again; existing
keyring entries are not migrated or deleted by this package. See
[docs/SECURITY.md](docs/SECURITY.md) for the tradeoff. Audio, including the
microphone, remains available through PulseAudio.

Review or undo what you have granted:

```sh
flatpak override --user --show io.github.vivienm.ChatGPT
flatpak override --user --reset io.github.vivienm.ChatGPT
```

Read [docs/SECURITY.md](docs/SECURITY.md) before widening it, particularly the
part about why this is not a trust boundary you should put client work behind.

## Control other devices (experimental)

This fork enables **Settings → Connections → Control other devices** on Linux.
Authorize this installation, complete any account verification, and select an
already enrolled Mac or Windows device signed in to the same ChatGPT account
and workspace. Keep that device awake and online. Availability and workspace
policy still apply; see the [official Remote guide](https://learn.chatgpt.com/docs/remote-connections).

The install-time patch opens the Connections UI and outbound catalog gates and
replaces the TPM-dependent Linux device-key addon with a software ECDSA P-256
provider. This follows the outbound-control approach in
[codex-desktop-linux](https://github.com/ilysenko/codex-desktop-linux/tree/49d5bc1c38aba9d25c1c798c1fffad8918390ae1/linux-features/remote-mobile-control),
adapted to this fork's local credential storage. It preserves the upstream
payload validation, authentication, pairing and server access checks.

Keys are created when you authorize the app, with `0600` permissions in a `0700`
directory under
`~/.var/app/io.github.vivienm.ChatGPT/config/chatgpt-flatpak-device-keys/`.
They are **extractable software keys**, without TPM or keyring protection.
Commands running inside this Flatpak can read them. Revoke the controller in
the remote device/account settings before deleting its local keys; deleting a
key alone does not revoke access server-side. See [the security details](docs/SECURITY.md#remote-control-identity).

This change is scoped to outbound control. It hides the local host setup tab,
does not start a remote-control daemon or enable this Linux machine as a host,
and requires no new Flatpak permissions. Commands on a connected device follow
**that device's** permissions;
this Flatpak does not confine the remote machine. Native Chrome integration on
this Linux machine remains a separate feature.

To try a local build, run `make deps`, `make install`, then `make run`.
Patching is checked against both pinned architectures by CI and fails the
installation if upstream changes the expected bundles. It is an experimental
adaptation, not official Linux Remote support. A successful package build does
not validate account enrollment or an end-to-end connection; test authorization,
a remote task, reconnection after restart and revocation with your devices.

## Chrome integration

**The browser controller / Chrome extension native transport is unsupported in this Flatpak package, including when Chrome is also installed as a Flatpak.** Installing the Chrome extension does not enable this connection. The extension may report `Native transport disconnected`, while the desktop app shows Chrome as "Not installed" even when the extension is installed.

A local native-messaging bridge experiment was withdrawn because its host wrapper was stored in app-writable data. Code inside the sandbox could modify what Chrome later executes on the host. This experiment was not a supported package feature.

There is no supported permission workaround. Granting general host execution through `--talk-name=org.freedesktop.Flatpak` / `flatpak-spawn --host`, or broad filesystem access, would weaken the sandbox without making the withdrawn bridge safe. A temporary permission grant does not protect a host wrapper that the Flatpak can still modify later. See [the security rationale](docs/SECURITY.md#chrome-native-messaging) for details.

## Maintaining it
I'm not the only one that can maintain it, you can too, simple as forking this repository and running the following.

```sh
make rename GH_USER=<you>   # do this first, sets the app-id everywhere
make deps                   # runtimes, SDK, Electron BaseApp, linter
make hashes                 # pin sha256 + size from upstream, sync version
make icons                  # replace placeholder icons with the real ones
make install && make run
```

### Repository setup

None of this is optional, and nothing here is created for you.

**Secrets**

- `GPG_PRIVATE_KEY` and `GPG_KEY_ID`. Flatpak refuses system-wide installs of an
  extra-data app from a remote that is not gpg-verified, so publishing without
  these produces a repo nobody can install system-wide.
- `AUTOMATION_TOKEN`, a personal access token with `contents: write` and
  `pull-requests: write`. The nightly update check uses it instead of
  `GITHUB_TOKEN` so PR checks can run without manual approval and merging
  can trigger the publication workflow. The
  workflow fails on the first step with a clear message if this is unset.

**Settings**

- Pages, source: GitHub Actions.
- Make the GHCR package public. A package created by the first push defaults to
  private, so the `docker://ghcr.io/...` install above returns 401 for everyone
  until you change it under Packages, package settings, change visibility.
- Allow auto-merge, under General. Without it the auto-merge step errors out.
- Branch protection on `main` requiring these four checks: `shellcheck`,
  `lint`, `build (x86_64)`, `build (aarch64)`.

**Labels and variables**

- A label named `automated`. `gh pr create --label` errors when the label does
  not exist, so without it the nightly job opens no PR at all.
- Repository variable `AUTO_UPDATE`. Unset means off, which is how this ships.
  Set it to `on` to let the nightly refresh PR auto-merge once those four
  checks pass, and to let a manifest change on `main` publish a release. Unset
  it to stop automatic merging and publication on manifest changes. Scheduled
  checks still open PRs, and manual/tag releases remain available. Disable the
  `update-check` workflow to stop scheduled checks entirely.

### The nightly refresh

`update-check.yml` runs `scripts/refresh-source.sh` at 04:17 UTC. Upstream
publishes a real APT repository, so the script reads `Version`, `Filename`,
`Size` and `SHA256` for both architectures from the `Packages` indexes, a few
kilobytes, rewrites the manifest's versioned `pool/` pins, bumps the AppStream
release entry, and opens a PR on `chore/upstream-refresh` labelled `automated`.
Versioned pins cannot rot silently: when upstream deletes an old `.deb` from
`pool/`, installs fail cleanly on 404 until the refresh PR lands. If the
repository has been quiet for 50 days the job also commits to
`chore/keepalive`, because GitHub disables scheduled workflows after 60 days
of inactivity.

## Autostart

To start it at login:

```sh
cp ~/.local/share/flatpak/exports/share/applications/io.github.vivienm.ChatGPT.desktop ~/.config/autostart/
```

It opens with its window. Starting minimized to the tray would need a flag from
the app itself, which upstream has not added.

## Known issues

**Browser controller / Chrome extension: `Native transport disconnected` or Chrome “Not installed”.** Chrome extension native transport is unsupported by this Flatpak package, including with Chrome Flatpak. Installing the extension or widening Flatpak permissions is not a supported fix. See [Chrome integration](#chrome-integration).

If something misbehaves, capture the log first:

```sh
flatpak run io.github.vivienm.ChatGPT 2>&1 | tee /tmp/chatgpt.log
```

**Codex Security scan registration is separate from command execution.** Start
a scan with **Security → Scans → + Scan**, which lets the workbench register its
`CODEX_SECURITY_SCAN_ID`. If the app reports that
`start_codex_security_prompt_only_scan` is unavailable, update or reconcile the
app/plugin integration; it is not fixed by granting broader Flatpak filesystem
or D-Bus permissions.

**The pet renders as an opaque box.** In order of likelihood:

1. `flatpak update`, then fully quit and relaunch the app. Old versions had a
   Wayland rendering bug, fixed upstream in 26.818.
2. If the launcher warned on stderr about a missing `GL/nvidia-*` extension,
   your NVIDIA driver updated before the matching flatpak GL extension.
   `flatpak update` delivers it; keeping flatpak auto-updates on stops this
   recurring. (On hybrid laptops rendering on the iGPU, the warning can be a
   false alarm.)
3. Still broken with everything current: it is an upstream rendering bug, and
   the fix arrives as an app update. Do not add `--socket=x11` to the manifest
   to work around it: that moves every user to XWayland, where the app can
   watch other X11 clients' input and windows.

**A blank window is not fixed with `--disable-gpu`.** That leaves Chromium with
no rasteriser and opens no window at all. Use `CHATGPT_DISABLE_GPU=1`, which
routes ANGLE at the bundled SwiftShader instead.

## Uninstalling

```sh
flatpak uninstall --user io.github.vivienm.ChatGPT
```

That keeps your data and the cached Codex runtime in
`~/.var/app/io.github.vivienm.ChatGPT`, which runs to several GB. To remove
that as well:

```sh
flatpak uninstall --user --delete-data io.github.vivienm.ChatGPT
```

After uninstalling, you can also remove the package repository:

```sh
flatpak remote-delete --user chatgpt
```

## Legal

The `extra-data` source type means the vendor binary is downloaded from OpenAI by *your* machine at install time. This repository hosts and redistributes no OpenAI executable code. It does commit seven application icons in `build-aux/icons/`, downscaled from the icon in upstream's `.deb`, because icons and AppStream metadata must exist at build time while the payload only arrives at install time. The MIT licence covers the packaging (manifest, scripts, metadata) and grants no rights to OpenAI software or services. Not affiliated with OpenAI. You need your own ChatGPT account and must comply with OpenAI's terms.

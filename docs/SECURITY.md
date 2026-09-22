# Sandbox posture

## What this package does

**zypak, not `--no-sandbox`.** Electron's SUID sandbox helper cannot work inside
a flatpak. The common workaround in the existing repackagers is to pass
`--no-sandbox`, which does not disable "a" sandbox. It removes renderer and GPU
process isolation entirely. From then on, any compromised web content inherits
*everything the flatpak holds*: the network share, every `--filesystem=` grant,
every `--talk-name=`. For an app that stores an account credential and reads
source code, that collapses two boundaries at once.

`org.electronjs.Electron2.BaseApp` ships [zypak](https://github.com/refi64/zypak),
which intercepts Chromium's sandbox calls and runs each renderer in a nested
flatpak sub-sandbox instead. Nothing is stubbed out: upstream ships no
`chrome-sandbox` and the BaseApp no longer ships `stub_sandbox`, and zypak
takes over before Chromium looks for a helper. `apply_extra` therefore
asserts rather than installs. It refuses to install if `zypak-wrapper` is
missing, and aborts if upstream starts shipping a `chrome-sandbox`, since
either would mean the sandbox model changed and a human should look.
`--require-version=1.8.2` is in `finish-args` because zypak's faster spawn
strategy needs `expose-pids`.

**Codex commands use Flatpak as their process sandbox.** Codex normally uses
`bwrap` and a user namespace to create its own command sandbox. A process
already inside Flatpak cannot create that nested user namespace, so merely
shipping another `bwrap` does not make command execution work. At install time
this package preserves upstream's `app/resources/codex` as `codex.real` and
puts a small wrapper at the original path. The wrapper passes
`--dangerously-bypass-approvals-and-sandbox` to Codex because the
environment already provides isolation.

The bypass flag applies to Codex's inner layer, not the Flatpak or host.
two potential layers:

1. Codex's inner command sandbox is disabled because Flatpak prevents it from
   being created.
2. The outer Flatpak sandbox remains in force for Codex, its shell commands,
   and the desktop app.

Model-generated commands can therefore use everything already visible inside
the Flatpak: explicitly granted workspace directories, app-persistent data in
`.codex` and `.cache`, the shared network, runtime tools, devices, and allowed
D-Bus services. They still cannot read arbitrary host files or execute host
commands. Granting `--filesystem=host`, broad home access, or
`--talk-name=org.freedesktop.Flatpak` would erase those protections and is not
part of this compatibility fix. Chromium renderer and GPU process isolation
continues to use zypak unchanged.

**Sealed permissions.** Deliberately absent from `finish-args`:

| Not granted | Why |
|---|---|
| `--filesystem=host` / `=home` | the app sees no user files until you say so |
| `--talk-name=org.freedesktop.Flatpak` | this permits `flatpak-spawn --host`, i.e. arbitrary command execution outside the sandbox. Flathub treats it as an exception-requiring rule. VS Code holds it, plus `--filesystem=host` and `--allow=devel`, which is why a flatpak'd VS Code is not meaningfully confined |
| `--device=all` | `--device=dri` covers GPU without handing over every USB device |
| `--socket=x11` / `--socket=fallback-x11` | Neither is granted. The launcher requires native Wayland, so X11-only sessions are unsupported. Network-shared abstract sockets remain a separate limitation, described below. |
| `--share=ipc` | Not granted: native Wayland does not need the host IPC namespace used for X11 shared memory. |

**Local credential storage.** The launcher selects `--password-store=basic`.
Neither `org.freedesktop.secrets` nor `org.kde.kwalletd5` / `org.kde.kwalletd6`
is granted. This intentionally prioritizes isolating the host's other secrets
from the application and its commands. Direct Secret Service access is not
limited to this application's items; GNOME Keyring permits access to unlocked
secrets by applications with access to the service. See the
[GNOME Keyring security FAQ](https://wiki.gnome.org/Projects/GnomeKeyring/SecurityFAQ).

Electron's basic backend does not provide meaningful application-level
encryption; treat stored credentials as plaintext even if their file format is
encoded or encrypted with a hardcoded key. See
[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
The app's private data remains under `~/.var/app/io.github.vivienm.ChatGPT/`.
Full-disk encryption protects this data while the volume is locked, not while
the session is running, and does not automatically protect exported files or
backups. Processes that can read this data can recover locally stored secrets.
This may include credentials for connected services, not only the ChatGPT login.

Changing from a keyring-backed installation may require signing in again. This
package does not migrate or delete existing keyring entries. The flag selects
Electron's backend; it does not rewrite independent credential handling in
bundled components. Validate login and persistence after upgrading.

Audio playback and microphone access (`--socket=pulseaudio`) are intentionally
retained, as is the Codex command-sandbox bypass described above.

Grant the minimum you need, per directory:

```sh
flatpak override --user --filesystem=~/code/thisproject io.github.vivienm.ChatGPT
flatpak override --user --show io.github.vivienm.ChatGPT     # review
flatpak override --user --reset io.github.vivienm.ChatGPT    # start over
```

The trade is real: with a sealed sandbox the agent can only run commands against
the tools inside the runtime, not your host toolchain. If you widen it to
`--talk-name=org.freedesktop.Flatpak` to get host execution back, you have
opted out of the sandbox. Do that knowingly, not by copying a snippet.

## Remote-control identity

Outbound control uses a software ECDSA P-256 key in the Flatpak's persistent
private config directory. The official Linux addon in 26.915.31945 uses a TPM;
this package does not grant access to `/dev/tpmrm0`. Instead, the install-time
patch redirects that addon's filename to `flatpak-device-key.cjs`. The original
wrapper still validates and canonicalizes enrollment/connection payloads and
adds the `codex-device-key-sign-payload/v1` domain before signing. Backend
availability, account/workspace access, authentication and pairing are retained.

The provider accepts only the caller's `allow_os_protected_nonextractable`
policy and rejects `hardware_only`. For compatibility with the existing
software-provider approach, it returns the protocol label
`os_protected_nonextractable`. **That label does not describe the actual
protection here:** the key is a plaintext PKCS#8 PEM, extractable by the user,
host processes with access to app data, and commands running inside the app.
It provides neither TPM-backed non-extractability nor OS keyring isolation.
This limitation is consistent with this fork's explicit local `basic` storage
choice, but the identity can authorize access to other computers as well.

Each key has its own exclusive-created UUID-named file (`0600`) in a private
directory (`0700`). Reading checks ownership, permissions, regular-file type,
link count, bounded size and key algorithm; symlink key files/directories are
rejected. Keys persist across updates and restarts. Removing local key files
does not revoke server-side authorization: revoke the controller using the
remote device/account settings first. Do not copy these keys into shared or
unencrypted backups.

No TPM, host execution, keyring or additional filesystem permissions are
granted. This patch does not enable inbound control or start a host daemon.
The Flatpak boundary only protects this local installation: actions on a remote
host execute with that host's credentials, tools, approvals and sandbox policy.

## Chrome native messaging

The browser controller / Chrome extension native transport is unsupported in this Flatpak package, including when Chrome itself runs as a Flatpak. The extension may report `Native transport disconnected`, and the desktop app may show Chrome as "Not installed" even when the extension is installed. These symptoms do not mean broader Flatpak permissions are needed.

A local native-messaging bridge experiment was withdrawn because it stored a host executable in data writable by the Flatpak. Code running inside the sandbox could modify that executable and change what Chrome later runs outside the sandbox. This experiment was not a supported package feature.

This design is consistent with [CWE-732: Incorrect Permission Assignment for Critical Resource](https://cwe.mitre.org/data/definitions/732.html): sandboxed code could modify code that would later execute on the host. CWE-732 is a general weakness classification, not a published advisory or CVE for this package.

There is no supported permission workaround, including a temporary one. A temporary filesystem grant does not protect a persistent host wrapper when the Flatpak can modify it later. Granting `org.freedesktop.Flatpak` access to enable `flatpak-spawn --host`, or broad host filesystem access, would weaken the intended sandbox without fixing that design.

Any future integration would need a separate security assessment. Host-executed code and its configuration must remain outside Flatpak-writable storage, including writable parent directories and symlink targets; protecting those files alone would not establish that the communication channel is safe.

## Codex Security scans

Codex Security scans must be started from **Security → Scans → + Scan** so the
workbench registers a `CODEX_SECURITY_SCAN_ID`. An error that the desktop
capability `start_codex_security_prompt_only_scan` is unavailable is separate
from command sandboxing. If it remains after this Codex wrapper fix, it points
to an app/plugin version or feature-integration mismatch, not a missing Flatpak
permission. Do not widen filesystem or D-Bus access to work around it.

## What this package does not do

**No network egress filtering.** `--share=network` is all-or-nothing; flatpak
has no destination-level control and the request for it
([flatpak#3054](https://github.com/flatpak/flatpak/issues/3054)) was closed.
Network access additionally exposes host services listening on abstract unix
sockets. If you need default-deny egress you must build it outside flatpak: a
dedicated network namespace around the launch, or nftables matching the app's
`app-flatpak-*.scope` cgroup.

**Not a trust boundary for other people's code.** Flatpak 1.17.4 (Apr 2026)
fixed a complete sandbox escape to host code execution; 1.19.0 (11 Aug 2026)
fixed ten more, including a path traversal in *extra-data extraction*
specifically. The flatpak boundary is a good usability and blast-radius
boundary. It is not where you should place a credential or client-data
boundary. For work under a client engagement, run the agent in a container cell
with its own credentials and a default-deny egress policy, and keep this
flatpak for personal use.

**Every install reaches OpenAI's CDN directly.** `extra-data` is fetched
per-machine at install and repair time; it cannot be baked into an OS image. On
a fleet with an egress policy, mirror the `.deb` to an internal artifact store
and repoint `url:`, which also gives you a stable hash and removes the rolling-URL
problem entirely.

## Supply chain

- The vendor payload is pinned by `sha256` + `size` and verified by flatpak
  before `apply_extra` runs. A rotated artifact fails the install rather than
  installing unknown bytes.
- The repo is GPG-signed. Signing is not cosmetic here: flatpak refuses
  system-wide installs of extra-data apps from sources that are not
  gpg-verified.
- `apply_extra` fails closed on unexpected layout instead of proceeding.
- No OpenAI executable code is rebuilt, patched into a binary artifact, or
  re-hosted. The one exception is artwork: `build-aux/icons/` holds seven PNGs
  downscaled from the icon in upstream's `.deb`, committed because AppStream
  metadata and icons must exist at build time while the payload only arrives at
  install time. Regenerate them with `make icons`.

## Reporting

Packaging issues: open an issue here. Bugs in the ChatGPT application itself go
to OpenAI. Reproduce them with the official `.deb` first, since this packaging
does change the process sandbox and the filesystem view.

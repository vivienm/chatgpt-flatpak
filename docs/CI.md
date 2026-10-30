# CI environments and upstream warnings

The workflows use explicit `ubuntu-24.04` and `ubuntu-24.04-arm` runners.
This keeps the currently validated host OS when GitHub moves `ubuntu-latest`
to Ubuntu 26.04, starting October 19, 2026. Runner images still receive updates;
only the Ubuntu release is fixed. Upgrade the runners deliberately and validate
both architectures before changing this baseline.

Build check names depend only on the architecture: `build (x86_64)` and
`build (aarch64)`. Together with `shellcheck` and `lint`, these are the four
required checks on `main`. Runner upgrades must not change those check names.

The installation smoke test also checks the built package's permission allowlist
on both architectures, including permissions inherited from its runtime. X11,
host IPC sharing, Secret Service, KWallet and broad filesystem/device/bus access
must not return.
`finish-args-only-wayland` is an intentional linter exception: this personal fork
requires Wayland, unlike Flathub's general compatibility recommendation.

## Remote-control bundle layout

Upstream 26.924.50649 moved the visibility function from `app-initial-*.js`
into `remote-control-connections-visibility-*.js`. The remote-control patch
accepts either layout, checks the availability/access conditions and ASAR
integrity, and leaves that function unchanged. Missing, duplicate or changed
visibility functions abort installation before any remote-control patch is
written. Both layouts are covered by `tests/test-remote-control.sh`; CI also
installs the actual pinned payload on each architecture.

Upstream 26.1021.22027 also moved the enablement bridge from `app-initial`
to `app-runtime` and replaced `set-remote-control-connections-enabled` IPC
with `remoteConnections.setRemoteControlEnabled`. This caused the October 24
build and release failures on both architectures: `remote catalog contract
changed: [remote-connections/gate-bridge]`. The patcher now resolves a unique
bridge owner across the old and new bundles, validates the service call and
patches only its Remote rollout gate. Loading guards, one-to-one pairing,
backend availability/access checks and the native signing wrapper are retained.
Tests cover both bridge layouts, unchanged unrelated gates, idempotence,
integrity failures and rejection before any archive writes.

Upstream 26.1027.30824 switched the main process from Vite's single
`main-*.js` bundle to rspack's `early-bootstrap.js` and numbered
`early-bootstrap-*-*.js` chunks. SWC also changed the native addon filename
from a template literal to a double-quoted string. The October 30 builds on
both architectures consequently stopped with `expected one main bundle,
found 0`. The patcher now resolves the unique device-key owner among the
supported main-process chunks and accepts both string forms. It still requires
the signing/validation anchors and valid ASAR integrity before writing.
Unrelated main chunks and worker bundles remain untouched; missing or duplicate
owners, changed contracts and corrupt integrity are regression-tested.

The [codex-desktop-linux 26.1027 repair](https://github.com/ilysenko/codex-desktop-linux/commit/f9b973bc03ea60fc971bd227948541fe84bce635)
was reviewed alongside both real vendor packages. Their pinned SHA-256 hashes
and sizes match, and both terminal and Remote patches apply, verify and remain
idempotent. This change retains the vendor's canonical signing wrapper and
the local software key store. All shell tests, ShellCheck, manifest lint and
an isolated x86_64 Flatpak build/install/smoke check pass. Full ARM64
installation remains for CI; an enrolled Remote connection was not tested.

## Upstream review on October 25, 2026

| Source | Reviewed revision | Result |
| --- | --- | --- |
| [rulin132/chatgpt-flatpak](https://github.com/rulin132/chatgpt-flatpak) | [`f89bb5417bb03918d2b27c997d822d48f487bedb`](https://github.com/rulin132/chatgpt-flatpak/commit/f89bb5417bb03918d2b27c997d822d48f487bedb) | Since the shared ancestor `7b0c76f`, only application pins and AppStream releases changed. Both architectures now use its current `26.1021.22027` payload, verified against OpenAI's APT indexes. |
| [ilysenko/codex-desktop-linux](https://github.com/ilysenko/codex-desktop-linux) | [`e84fe858fd62bf59678025402384519e0017c0f9`](https://github.com/ilysenko/codex-desktop-linux/commit/e84fe858fd62bf59678025402384519e0017c0f9) | Reviewed the current outbound loader, visibility, enablement and device-key contracts, including the [26.1021 repair](https://github.com/ilysenko/codex-desktop-linux/commit/d73e1453ee0b47aafe0eb90ee3866cf187c4dc19). The local Flatpak adaptation now handles the service bridge in `app-runtime`. |

These are source references, not interchangeable package dependencies. The
Flatpak fork retains its own app ID, Wayland policy, local credential storage
and outbound-only Remote scope. The broader Linux hosting, daemon and keychain
framework from `codex-desktop-linux` is not imported. Its latest startup-config
fix concerns injected `--remote-control` / `app-server proxy` arguments;
this Flatpak adaptation does not inject those arguments. The original Remote
reference and MIT notice remain in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

To refresh again, fetch `upstream`, compare packaging changes, run `make hashes`,
review the outbound Remote contracts at a specific `codex-desktop-linux`
revision, and record it here. CI must install both real architecture payloads;
synthetic bundle tests alone cannot detect every vendor layout change.

The October 24 refresh [PR #26](https://github.com/vivienm/chatgpt-flatpak/pull/26)
merged at 04:27:28 UTC, before either architecture completed its installation
check. The API audit found neither classic protection nor effective rules on
`main`. `scripts/check-auto-merge.sh` now refuses to arm auto-merge unless
classic branch protection requires `shellcheck`, `lint`, `build (x86_64)` and
`build (aarch64)`. API errors also refuse merging. The PR remains available for
review when protection is missing; this guard does not change GitHub settings.

Validation: all shell test entrypoints and ShellCheck pass; manifest lint has
no errors (the existing 26.08 runtime advisory remains). Both vendor packages
match their pinned sizes and SHA-256 hashes. Terminal and Remote patches apply
to both real ASARs and verify their resulting integrity hashes. An x86_64
Flatpak build, isolated installation with `apply_extra`, and `ci-smoke.sh` pass.
ARM64 installation/runtime checks remain for CI. An enrolled Remote session
and graphical startup were not tested by these checks.

## Remaining warnings reviewed on September 22, 2026

- `runtime-update-available-to-org.freedesktop.Platform-26.08`: this is a
  recommendation to upgrade the application runtime, not the CI host OS.
  The Electron BaseApp now has a 26.08 branch, but the matching
  `ghcr.io/flathub-infra/flatpak-github-actions:freedesktop-26.08` image was not
  available when checked. Keep the existing 25.08 runtime, SDK, BaseApp and
  pinned builder image together for now. A runtime migration needs both
  architecture installation checks and a graphical launch test; do not hide
  the recommendation with a linter exception.
- Node `DEP0005` (`Buffer()`) occurs in `actions/download-artifact@v8.0.1`,
  which is the latest published release at the time of review. Node `DEP0040`
  (`punycode`) occurs in `actions/deploy-pages@v5.0.0`; the available v5.0.1
  patch changes deployment polling, not its dependencies. These warnings come
  from bundled third-party action code. Keep them visible until upstream
  provides a fix, and retain full commit SHA pins when updating the actions.
- Git's initial-branch-name hint comes from checkout's temporary repository.
  It does not affect the selected ref and requires no repository change.

References:

- [Ubuntu runner migration](https://github.com/actions/runner-images/issues/14748)
- [Electron BaseApp 26.08](https://github.com/flathub/org.electronjs.Electron2.BaseApp/issues/75)
- [Download Artifact releases](https://github.com/actions/download-artifact/releases)
- [Deploy Pages v5.0.1 changes](https://github.com/actions/deploy-pages/releases/tag/v5.0.1)

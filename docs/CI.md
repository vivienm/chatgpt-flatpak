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
host IPC sharing, KWallet and broad filesystem/device/bus access must not return.
`finish-args-only-wayland` is an intentional linter exception: this personal fork
requires Wayland, unlike Flathub's general compatibility recommendation.

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

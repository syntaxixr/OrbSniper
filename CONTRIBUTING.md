# Contributing

Thanks for wanting to help. A few things worth knowing before you start.

## Reporting a bug

Open an [issue](../../issues/new/choose) and paste the console output — the **Copy** button in the app's console header grabs the whole log. Without it most reports are guesswork.

Please include your Windows version and whether you're behind a VPN.

## Suggesting a feature

Open an issue and describe what problem it solves for you. Concrete beats abstract: "the app should remember my language" is easier to act on than "improve UX".

## Sending code

```bash
git clone https://github.com/syntaxixr/OrbSniper.git
cd OrbSniper
npm install
npm start
```

Then:

1. Branch off `main`.
2. Keep the style of the file you're editing — comments in English, two-space indent, no build step.
3. Run `npm test` (no Discord or network needed), then run the app and click through what you changed. A screenshot in the PR helps.
4. If you touch the UI text, add the strings to **all ten languages** in `renderer/i18n.js`. A missing key falls back to Russian, which looks broken.

## Project layout

| File | What lives there |
|---|---|
| `main.js` | Electron main process: launches Discord, pre-flight checks, IPC |
| `preload.js` | The bridge between the window and the main process |
| `quest.js` | The quest engine injected into Discord |
| `renderer/index.html` | Window markup |
| `renderer/style.css` | All styling |
| `renderer/app.js` | Window logic |
| `renderer/i18n.js` | Every piece of UI text, ten languages |
| `test/run.js` | The checks behind `npm test` and CI |
| `scripts/dist.js` | Release build: electron-builder with our portable launcher |
| `build/portable.nsi` | The portable launcher: unpacks once, then starts instantly |
| `build/icon.svg` | Source of the app icon, favicon and logo |

## What won't be merged

- Anything that reads, stores or transmits a Discord token. The whole point is that it never touches one.
- Telemetry, analytics, "anonymous usage stats".
- Bundled installers, adware, affiliate links.
- Removing the risk disclaimer or the warnings about Discord's rules.

## Licence

By contributing you agree your code ships under the [MIT licence](LICENSE) with the existing copyright notice intact.

# Security

## What this app touches

OrbSniper launches your installed Discord with a remote debugging port on localhost and injects quest logic into it. It also writes one flag to Discord's own `settings.json` to allow that.

It does **not** read, store or transmit your Discord token. Every API call is made by Discord itself from your own session.

Network activity: one request to `discord.com` during the pre-flight check to confirm you're online, plus whatever your Discord client does normally. Nothing is sent anywhere else — no telemetry, no analytics, no update pings.

## What the debugging port means for you

This is the part that deserves plain language, because "we never read your token" is true but not the whole story.

While Discord runs with a debugging port open, **any program running under your Windows account can connect to that port** and drive your Discord client with full access — including reading your token. OrbSniper does not do this, but the door it opens is not OrbSniper-specific. The port only listens on `127.0.0.1`, so nothing outside your machine can reach it, and a normal desktop with no malware on it is not at risk. On a shared or already-compromised machine, it is a real exposure.

Two practical consequences:

- **The port stays open until Discord is restarted.** Closing OrbSniper does not close it. If you want it shut immediately, close Discord and open it again normally.
- **The `DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING` flag stays in Discord's settings** after OrbSniper is gone. The original file is backed up next to it as `settings.json.orbsniper.bak`, and a settings file that cannot be parsed is left untouched instead of being overwritten. To undo the flag, set it to `false` or delete the line.

The portable `OrbSniper.exe` unpacks itself once into `%LOCALAPPDATA%\OrbSniper\runtime\<version>-<hash>` and starts from there afterwards. The folder name carries the hash of the build, so a new exe never runs old files, and folders of older builds are deleted. Removing the whole `runtime` folder is safe: the next launch simply unpacks again.

The port is no longer hardcoded to `9222`: if that one is busy, the app picks a free port in the `9222–9260` range instead of failing.

## Reporting a vulnerability

Found something that could harm users? Please **don't** open a public issue.

Message the author privately on Telegram: [@synaps_ss](https://t.me/synaps_ss)

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get an answer as fast as the author can manage.

## Verifying what you downloaded

Every release lists the SHA-256 of the `.exe` on its page. Check it before running:

```powershell
Get-FileHash .\OrbSniper.exe -Algorithm SHA256
```

If the hash doesn't match the one on the release page, don't run the file — and tell the author.

## Dependencies

`npm audit` reports zero known vulnerabilities. The build toolchain was updated specifically to clear 14 advisories (13 high, 1 critical) that came in through the old `electron-builder` chain. Those were build-time only and never shipped inside the `.exe`, but there is no reason to carry them.

The shipped Electron runtime was moved from 33 (out of support since 2025) to 44.

## Supported versions

Only the latest release gets fixes.

| Version | Supported |
|---|---|
| 1.6.x | yes |
| older | no |

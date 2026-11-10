# Handoff: deploy Falcon v2 to the fleet Mac

For a local Claude Code session on Mani's laptop. The laptop is on Tailscale and reaches the fleet Mac over SSH; this file is everything that session needs to know.

## What exists

- Repository: `https://github.com/mvedma04005/launch-eng-review-agent`, branch `rebuild`. Clone it locally first.
- `v2/` is the new PR review engine (TypeScript, Node 22.18+, no native deps). `v2/README.md` is the entry point; `v2/deploy/MAC.md` is the Mac runbook.
- `docs/rebuild-design.md` explains the design; `docs/gap-analysis-vs-op3-investigator.md` lists what is done and what is next.
- Tests: `cd v2 && npm install && npm test` (35 tests) and `npm run typecheck`.

Decisions already made. Do not reopen them in this session:
- Build our own engine (not onboard onto OP3 Investigator), modeled on OP3's design.
- Runs on the dedicated fleet Mac under launchd, one process, each review in a child process.
- Requests come from the launch-engineering Google Chat space through a Chat app identity; GitHub polling backs it up.
- Only `ROKT/launch-engineering` is ever reviewed. The allowlist is `github.repos` in the config; leave it alone.
- Inference is the Anthropic API directly. Reviewer and verifier: `claude-opus-5-5`, effort `high`. Lessons: `claude-haiku-5-5`.
- Reviews post as comments plus a `Falcon review` check run. Approval mode is off. launch-engineering requires a human code-owner approval anyway, so a bot could never be the gate.

## The job

Get the engine installed on the fleet Mac in dry-run mode, confirm it is alive, and leave a clear list of what still needs credentials.

### 1. Reach the fleet Mac

Mani's past connection scripts are in `~/Documents/Code/Hazel/scripts/fleet` on the laptop. Read them for the SSH alias, user and any port forwarding. Confirm with `ssh <alias> 'hostname; sw_vers -productVersion; id -un'`. Everything on the Mac should run as the dedicated service user if one exists; otherwise note which user you used.

### 2. Install

On the fleet Mac, as that user:

```bash
ssh <alias> 'bash -c "$(curl -fsSL https://raw.githubusercontent.com/mvedma04005/launch-eng-review-agent/rebuild/v2/deploy/bootstrap-mac.sh)"'
```

The bootstrap clones the engine to `~/falcon`, searches the Mac for an existing Anthropic key (`ANTHROPIC_API_KEY` in shell profiles, or the login Keychain) without printing it, writes `~/.config/falcon/env` (mode 600), writes `~/.config/falcon/falcon.yaml` with `dryRun: true`, and installs `~/Library/LaunchAgents/com.rokt.falcon.plist`. It needs Node 22.18+ and git on the Mac; install with Homebrew if missing.

If no key is found on the fleet Mac and one exists on the laptop:

```bash
ssh <alias> 'cat >> ~/.config/falcon/env' <<< "ANTHROPIC_API_KEY=$(security find-generic-password -s ANTHROPIC_API_KEY -w)"
```

Never echo, log or paste a key value anywhere, including in this session's output.

### 3. Verify

```bash
ssh <alias> 'launchctl print gui/$(id -u)/com.rokt.falcon | head -20; tail -n 30 "$HOME/Library/Application Support/falcon/logs/falcon.err.log"'
```

Expected: the agent is loaded, and the log's first lines say `falcon serving` with `dryRun: true`. A line about a missing GitHub credential is expected until step 4 is done; the process will restart under launchd every 15 seconds until then, which is fine.

With `http.port: 8088` in the config, `ssh -L 8088:127.0.0.1:8088 <alias>` then `http://127.0.0.1:8088/` shows the dashboard.

### 4. What still needs credentials (needs Mani or a GitHub org admin)

GitHub App, created in the ROKT organization (org admin needed):
- Name `Falcon review`. Permissions: Pull requests read and write, Checks read and write, Contents read, Metadata read. No webhooks (we poll).
- Install it on `ROKT/launch-engineering` only.
- Generate a private key and put it on the fleet Mac at `~/.config/falcon/github-app.pem` (mode 600). In `~/.config/falcon/env` add: `FALCON_GITHUB_PRIVATE_KEY="$(cat "$HOME/.config/falcon/github-app.pem")"`. Put the App id in `falcon.yaml` under `github.appId`.

Google Chat app (Google Cloud project; steps in `v2/deploy/MAC.md`, "Google Chat setup"):
- Service account key into `env` as `FALCON_GOOGLE_SERVICE_ACCOUNT_JSON='{...}'` on one line.
- Pub/Sub topic and pull subscription; `chat-api-push@system.gserviceaccount.com` publishes to the topic.
- Chat app configured with Pub/Sub delivery, added to the launch-engineering review space. Space id into `chat.spaces`, project and subscription into `chat.pubsub`.
- Until a Workspace admin grants the app `chat.app.messages.readonly`, people post `@Falcon <PR link>`.

After any config or env change: `ssh <alias> 'launchctl kickstart -k gui/$(id -u)/com.rokt.falcon'`.

### 5. First real test, still in dry run

Post a launch-engineering PR link in the review space. Within seconds the thread should get "👀 Looking". Within minutes `ssh <alias> 'cd ~/falcon/v2 && npm run falcon -- jobs'` should show the job as `skipped` with the note `dry run: review rendered, nothing posted`, and `npm run falcon -- job <id>` shows the rendered review and the tool-call trail. Read several of these. When they look right, set `dryRun: false` and restart.

## Guardrails for this session

- Never commit or print secrets. The env file is the only place they live.
- Do not push to `justinlee1253/launch-eng-review-agent`. Our code lives in `mvedma04005/launch-eng-review-agent`.
- Do not change `github.repos`, the policy pack, or the verdict mode. Those are decisions, not settings.
- Report exactly what was verified and what was not. "Installed" means the agent is loaded and logging; "working" means a dry-run review was rendered for a real PR.

## Prompt to start the local session with

> Read `docs/HANDOFF-fleet-deploy.md` in this repository and carry it out. The fleet Mac SSH details are in `~/Documents/Code/Hazel/scripts/fleet`. Stop and tell me what you need when you reach a step that requires a credential I have not provided.

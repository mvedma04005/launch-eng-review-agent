# Running Falcon on a dedicated Mac

One Mac, one service user, one launchd agent, state in that user's Library folder. Nothing depends on a person being logged in or awake, and a restart resumes from SQLite.

## Prepare the Mac once

1. Create a dedicated local user (for example `falcon`) and log in as it. Everything below runs as that user. Enable automatic login for it so a power cycle brings the agent back, and disable sleep in Energy settings.
2. Install Node 22.18 or newer and git: `brew install node@22 git`.
3. Clone the repository into that user's home and run `bash v2/deploy/install-mac.sh`. It creates:
   - `~/.config/falcon/env` (mode 600) for `ANTHROPIC_API_KEY`, `FALCON_GITHUB_PRIVATE_KEY` and the optional `FALCON_NOTIFY_WEBHOOK`;
   - `~/.config/falcon/falcon.yaml` with `dryRun: true`, process isolation on, and the launch-engineering repository;
   - `~/Library/Application Support/falcon` for the SQLite store, git mirrors, worktrees and logs;
   - `~/Library/LaunchAgents/com.rokt.falcon.plist`, bootstrapped and started.
4. Fill in the secrets and the GitHub App id, then `launchctl kickstart -k gui/$(id -u)/com.rokt.falcon`.

The launcher refuses to start if the env file is not mode 600. Secrets never appear in the plist or the process list.

## Stage, then enable

Run with `dryRun: true` for a few days. Every eligible PR is reviewed end to end and the rendered review is kept in the store, but nothing is posted. Read them with `falcon jobs` and `falcon job <id>` or on the dashboard at `http://127.0.0.1:8088/`. When the output is right, set `dryRun: false` and restart.

## Operate

| Need | Where |
| --- | --- |
| Is it alive | `launchctl print gui/$(id -u)/com.rokt.falcon`, `/healthz`, the dashboard |
| What is queued or in review | dashboard, `falcon status` |
| Why a review was held | `falcon job <id>` shows the reason, the tool-call trail and the event trail |
| Republish a review that failed to post | `falcon replay <id>`; the retained review is posted without another model run |
| Alerts | stalled queue, spend near the daily cap, repeated failures, sent to the webhook and logged |
| Logs | `~/Library/Application Support/falcon/logs/` |
| Upgrade | `git pull`, `npm ci --omit=dev`, `launchctl kickstart -k gui/$(id -u)/com.rokt.falcon`. In-flight reviews are in child processes; the daemon waits for leases to expire and requeues them |

## Failure modes and what happens

| Failure | Behavior |
| --- | --- |
| Daemon crashes | launchd restarts it within 15 s; leased jobs are recovered when their lease expires |
| A review process hangs or balloons | killed at lease time plus 60 s; the job is requeued, after three attempts failed with the reason |
| GitHub unreachable | polling and publication back off; finished reviews are retained and retried, then parked for `falcon replay` |
| Anthropic rate limit | the SDK retries; the worker defers the job with backoff |
| Mac loses power | automatic login and launchd bring it back; SQLite is durable |
| The Mac dies | the store is a single file. Back it up with Time Machine or a nightly copy; a replacement Mac restores it and continues |

## What this is not

It is one host. If launch-engineering outgrows a single Mac, the same code runs in a container with a Postgres store behind the same interface. That is the "later" the design doc describes, not something the Mac needs today.

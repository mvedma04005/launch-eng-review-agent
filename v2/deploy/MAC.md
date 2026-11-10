# Running Falcon on a dedicated Mac

One Mac, one service user, one launchd agent, state in that user's Library folder. Nothing depends on a person being logged in or awake, and a restart resumes from SQLite.

## Fastest path

As the dedicated service user on the Mac, with Node 22.18+ and git installed:

```bash
curl -fsSL https://raw.githubusercontent.com/mvedma04005/launch-eng-review-agent/rebuild/v2/deploy/bootstrap-mac.sh | bash
```

It clones the engine to `~/falcon`, finds an existing Anthropic API key in the shell profiles or the login Keychain without printing it, writes `~/.config/falcon/env`, and runs the installer below. Then fill in the GitHub App id and the Chat settings and restart the agent.

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

## Google Chat setup (one time, in Google Cloud)

Falcon is a Chat *app*, not a person. Events reach the Mac through a Pub/Sub subscription the daemon pulls from, so nothing needs an inbound URL.

1. In a Google Cloud project, enable the Google Chat API and the Pub/Sub API.
2. Create a service account (for example `falcon-chat`), download a JSON key, and put it in `~/.config/falcon/env` as `FALCON_GOOGLE_SERVICE_ACCOUNT_JSON='{...}'` on one line.
3. Create a Pub/Sub topic (for example `falcon-chat-events`) and a pull subscription on it (for example `falcon-chat-pull`). Grant `chat-api-push@system.gserviceaccount.com` the Pub/Sub Publisher role on the topic, and the service account the Pub/Sub Subscriber role on the subscription.
4. In the Chat API configuration page: name it Falcon, give it an avatar, enable joining spaces and group conversations, set the connection type to Cloud Pub/Sub with that topic, and make it visible to the people or groups who will use it.
5. Add the Falcon app to the launch-engineering review space. Put the space id (`spaces/...`) in `chat.spaces` and the project and subscription in `chat.pubsub`.
6. Bare links without a mention are picked up by polling only if a Workspace admin grants the app `chat.app.messages.readonly`. Until then, post `@Falcon <PR link>`.

Expected timing: a mention reaches the Mac within about a second, "👀 Looking" appears within another second or two, and the review follows at the pace of the queue. Other repositories' links are refused in the thread; only `ROKT/launch-engineering` is ever reviewed.

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

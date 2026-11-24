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
2. Create a service account (for example `falcon-chat`) with no key. Sign in keyless (workload identity federation), so no Google credential is ever downloaded:
   - On the Mac, run `falcon keyless-key ~/.config/falcon/chat-signing.pem`. It creates an owner-only signing key that never leaves the host and prints only the public half (a JWKS).
   - In the project, create a workload identity pool with an OIDC provider that carries that JWKS, an issuer URL of your choice, and an attribute condition on the subject. Grant the pool's subject `roles/iam.workloadIdentityUser` on the service account. Enable the IAM Credentials and Security Token Service APIs.
   - Put the config, which holds no secret, in `~/.config/falcon/env` on one line: `FALCON_GOOGLE_SERVICE_ACCOUNT_JSON='{"audience":"//iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>","service_account":"<email>","issuer":"<issuer URL>","subject":"<subject>","key_id":"<kid from the JWKS>","signing_key_file":"/Users/<you>/.config/falcon/chat-signing.pem"}'`.
   - Falcon signs a five-minute note with the local key, and Google swaps it for a one-hour token for the service account. To revoke, delete the provider. A downloaded JSON key in the same variable still works, but it is long-lived and a security scanner will flag it.
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

## Merge gate and merge queues

With `gate.enabled: true` Falcon posts a second check, "Merge gate", on each open PR into the default branch: green when a team member (the pack's `team.members`) or Falcon approved the latest commit. Make that check required in the repository's ruleset.

A merge queue works with no extra setup. GitHub tests a queued PR on a temporary commit, on a branch named `gh-readonly-queue/<base>/pr-<number>-<sha>`, and a required check must also report there. On every pass the gate reads those branches and gives each queue commit the decision its PR's own commit last got. It needs no permission beyond reading the repository. The probe (below) sees a new queue commit within `gate.probeSeconds`, so the check appears there within seconds. With the probe off, allow up to `gate.pollSeconds` (30 by default). GitHub queues a stack as one group and can name its queue commit after any PR of the stack, so that commit can carry the whole open stack. With `gate.stacks` at `on`, the commit passes only when every open PR of the stack has a saved pass for its current head and base and the chain closes on the queue's branch; otherwise it waits and names the PR of the stack that has no current pass. So a merge of part of a stack waits until every open PR above it passes too. With `off` or `shadow`, the chain stops at the queued PR, so a stack still merges one PR at a time through the queue. That is safe because GitHub requires the check on every PR of a merge group, and then no PR above the bottom has a current pass.

To trial a queue on a side branch before turning it on for the default branch, list the branch in `gate.branches`. PRs into a listed branch are judged like PRs into the default branch.

The gate runs a pass when something changes on GitHub. Every `gate.probeSeconds` (5 by default) it asks GitHub for two things: the open PR updated last, and the merge queue branches of the default branch and of each branch in `gate.branches`. A review, a push or an edit moves a PR's update time, so it makes that PR the one updated last. When either answer is different from the last look, the gate runs a pass at once, so an approval turns the check green within seconds. A pass also runs when a look fails, and when `gate.pollSeconds` (30 by default) have gone by since the last pass. Each look costs about 2 GitHub calls, plus 1 for each branch in `gate.branches`: at 5 seconds that is about 1,440 calls an hour, and a pass runs only on a change or after `gate.pollSeconds`. Set `gate.probeSeconds: 0` to turn the probe off and go back to a pass every `gate.pollSeconds`. Each pass also judges the next 3 open PRs by number, in turn, so a change that does not move a PR's update time (for example a push to its base branch) is still caught. At about 180 open PRs, each PR is judged again about every 30 minutes.

GitHub checks every PR of a stack against the rules of the stack's base, so each PR in a stack needs the check too. `gate.stacks` sets what the gate does with a PR in a GitHub stack on the default branch. `off` (the default) skips these PRs, as before. `shadow` judges each one on its own change against its direct base and writes the verdict to the log as `merge gate decided (shadow)`. It posts nothing and saves nothing: no check, no decision, no observation, except the withdrawal described below. In shadow a stacked PR is judged when a PR of its stack changes and in its turn of the rolling recheck, which judges a few unchanged PRs on each pass and reaches every open PR in about 30 minutes, so its first log line can come up to about 30 minutes after a request. `on` judges them the same way and posts the check, with a title that names the base, for example "Approved for its own change on feat-a". A PR on another PR's branch without a GitHub stack is never judged, and neither is a stacked PR from a fork. Roll out in this order: set `shadow`, compare the log lines with the approvals on GitHub for one real stack, then set `on`. To roll back, set `off` (or `shadow`). A stacked PR the gate judged before then gets the check "Waiting: stacked PRs are not judged now" on its head when its last decision is a pass, and again each time its head changes, so a push back to an older commit cannot bring back the pass that commit got. A stacked PR the gate never judged gets nothing. A change to `gate.stacks` re-judges every PR on the next pass. Shadow writes no observations, so after the change to `on`, a person's approval given on a stacked PR during shadow cannot be bound to a change and does not count. The check says so; ask for that approval again.

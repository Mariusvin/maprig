# Switch local subscription accounts in Docker

The repository helper `scripts/local-agent-accounts.mjs` enrolls and selects
saved subscription logins for the OpenAI and Claude native CLIs in an existing
Linux Docker installation. Run it from the checkout on the host with Node.js
22 or 24 and Docker available. Its default container is `openrig-isolated`;
use `--container <name>` for another installation.

Each additional account needs its normal provider sign-in once. Later switches
reuse its saved login without logging out the outgoing account. Providers may
still expire or revoke a login. The helper selects an account on request; it
does not monitor quotas or automatically rotate accounts.

The CLIs, daemon and managed seats must use the same persistent home and native
configuration directories inside the container. This helper supports Linux
file-backed subscription credentials. It requires a native auth status that can
identify the account. Keychain-only, ephemeral, Console API and third-party
gateway authentication are outside this workflow. Remove model API and auth-token
overrides from the service configuration before using subscription seats.

## Enroll accounts once

Inspect the current saved logins:

```sh
node scripts/local-agent-accounts.mjs list --provider openai
node scripts/local-agent-accounts.mjs list --provider claude
```

`primary` is reserved for the login originally present in the native home.
An empty native home still lists `primary` with `loginPresent: false`.
Choose another label for each enrollment, including the first Claude account:

```sh
node scripts/local-agent-accounts.mjs add work --provider openai
node scripts/local-agent-accounts.mjs add personal --provider claude
node scripts/local-agent-accounts.mjs add work --provider claude
```

Complete the native sign-in in your browser, selecting the intended account.
The OpenAI enrollment uses device authorization by default. If the account
requires it, enable device authorization in its security settings, then retry
with a fresh code. `--browser` selects the ordinary browser login instead.
If a workspace administrator has disabled device authorization, use the provider's
normal browser login instead:

```sh
node scripts/local-agent-accounts.mjs add work --provider openai --browser
```

The helper temporarily forwards `localhost:1455` on both loopback address families
to the native callback inside the existing container. It refuses an occupied
callback port. Complete the browser prompts using the intended account and
workspace; no code needs to be pasted into a terminal. The forwarder closes when
the native login ends, without changing Docker port mappings. Browser sign-in
remains subject to workspace access rules. This fallback follows the provider's
[headless authentication guidance](https://learn.chatgpt.com/docs/auth#login-on-headless-devices).

Claude enrollment uses its subscription login flow. Native prompts and temporary
login codes appear only in the terminal where you run the command.

Enrollment uses a separate private configuration directory and leaves the active
login in place. `add` refuses an already signed-in label. The labels contain
letters, digits, underscores or hyphens, start with a letter or digit, and have
at most 48 characters. Use non-sensitive labels because they appear in status.

## Select a saved login

Preview the affected rigs and seats, then switch:

```sh
node scripts/local-agent-accounts.mjs switch work --provider openai --plan
node scripts/local-agent-accounts.mjs switch work --provider openai
node scripts/local-agent-accounts.mjs switch primary --provider openai
node scripts/local-agent-accounts.mjs switch personal --provider claude
```

Switching a provider selects its login for all seats that use that native home.
It briefly stops each affected rig with a snapshot, saves the latest outgoing
credential file, selects the incoming login, checks its account identity, and
resumes the same rig with `rig up <rig-name> --existing`. Native conversation
files, session databases and project trust remain in their original locations.
For Claude, the selected account's identity metadata changes while active project
settings remain in place.

A shared rig restarts as a whole, including peers using another runtime.
The plan lists those peers. The helper requires a native resume ID for each live
agent and verifies a `resumed` result for every such peer before reporting
`outcome: "resumed"`. That verifies restore continuity and local account selection;
it does not prove that the provider accepted a new model request or has capacity.

Wait for idle seats before switching. The helper refuses busy or unknown activity
unless you explicitly add `--interrupt`. This permits interrupting those peers;
it does not bypass missing conversations, incomplete snapshots or login checks.
Do not launch other native CLI sessions, enroll accounts, or run independent rig
launch/restore commands during a switch. The helper serializes its own switch
operations and scans for remaining provider processes, but independent launch
paths do not participate in its lock.

Selecting Claude does not change a seat's runtime. Run the provider setup in the
container and use `runtime: claude-code` in the intended agent specification:

```sh
docker exec openrig-isolated rig setup --providers claude --no-herdr --json
```

See [agent specifications](agent-spec.md) for runtime settings and
[local agent connections](local-agent-connections.md) for installing a CLI in the
persistent home. Run a small model task after initial setup to verify actual
provider access.

## Recover an interrupted switch

An incomplete operation reports the observed active label, the rigs known to
have stopped and any rig whose stop outcome is unknown. A timeout is not proof
that the underlying action failed. Inspect the current state before another
attempt:

```sh
node scripts/local-agent-accounts.mjs list --provider claude
docker exec openrig-isolated rig ps --nodes -A --json
```

If `recoveryRequired` is true, keep affected rigs stopped and close any independent
sessions using that provider. Roll the pending credential selection back:

```sh
node scripts/local-agent-accounts.mjs recover --provider claude
```

Recovery restores the outgoing credential and Claude account metadata from the
private journal backups. Both saved logins remain. Locks belonging to a terminated
Linux process are reclaimed using its process ID and start time; a living switch
owner is refused. Recovery also clears dead-owner locks left before a journal
was written. It does not restart rigs. Check status, then resume each stopped rig
by its actual name:

```sh
docker exec openrig-isolated rig up <rig-name> --existing --json
```

An incomplete restore is reported without an automatic retry. Never substitute
a fresh seat launch when recovering a conversation-preserving switch.

## Private state and persistence

Saved logins live under `$OPENRIG_HOME/account-homes/<provider>/<label>` inside
the persistent container home, with private directory and file permissions.
The active native home remains stable so existing resume IDs still resolve.
Switch results contain labels and operational metadata; they omit tokens and
account email addresses. Native subscription status is reduced to a local opaque
identity fingerprint for comparison, and that fingerprint is not printed by the
switch command.

Treat the entire persistent home volume as private. Keep it out of images, build
contexts, Git, public logs and proof artifacts. Ordinary container recreation
retains its saved logins when the same home volume is mounted. Deleting that
volume removes them. No provider logout command is used by this workflow.

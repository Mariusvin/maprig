# Connect a local agent client

OpenRig can work with an agent's existing signed-in CLI account. A separate
model API key is unnecessary when that CLI already uses a subscription login.
Choose the connection according to where the agent should run.

## Use a desktop app or CLI to operate OpenRig

An MCP-capable client can use OpenRig's existing stdio server as a tool
connection. The client remains responsible for its model, login and conversation.
OpenRig supplies coordination tools for rigs, messages, captures and the durable
work queue.

When OpenRig runs directly on the same machine, configure the client's MCP
server command as `rig`, with arguments `["mcp", "serve"]`.

For a Windows client and the isolated Docker installation, launch the MCP server
inside the existing container. The equivalent process command is:

```sh
docker exec -i openrig-isolated rig mcp serve
```

Use `-i` to retain stdin. Do not add `-t`: a terminal is unnecessary for the
newline-delimited MCP transport. Substitute the actual running container name.
The daemon stays inside its existing container and retains its current state.

For clients accepting an `mcpServers` configuration, merge this entry into the
existing configuration, retaining other servers:

```json
{
  "mcpServers": {
    "openrig": {
      "command": "docker",
      "args": ["exec", "-i", "openrig-isolated", "rig", "mcp", "serve"]
    }
  }
}
```

Some clients use another configuration format or provide their own server
registration command. Supply the same executable and argument array there.
The client process must be able to run Docker. Reconnect its MCP server or start
a new conversation after registration, according to that client's behavior.

The server uses the daemon connection and operator authentication already
configured inside the container. No model credentials need to cross the Docker
boundary. Keep the client's model login in the client.

## Verify the connection

Check the deployment first:

```sh
docker exec openrig-isolated rig daemon status
```

Then connect from the client, list its OpenRig tools and call `rig_status`.
Success is a tool result containing `status: "ok"`, without `isError: true`.
`rig_ps` can read the rig list without launching an agent. A successful process
start alone does not verify the tool connection.

If the server disconnects, inspect the Docker error and confirm the container
is running. A missing `rig` executable means the selected container does not
contain the OpenRig CLI. Use its actual executable path when necessary.

If tools are listed but a call reports that approval is required, the connection
has initialized but the client's tool policy has stopped execution. Approve the
specific operation in an interactive client, or configure a rule for that tool
before a non-interactive run. A client that cannot ask for approval will otherwise
reject the call. For a read-only connection check, allow only `rig_status` and
retain the other tools' existing approval policies. A tool list or an agent's
exit code alone does not prove the call succeeded; inspect its returned result
and any tool error.

## Seat identity and external sessions

An unbound tool connection can inspect OpenRig. Seat-scoped queue operations
need an actual OpenRig session identity. For an existing registered seat,
forward its returned `OPENRIG_SESSION_NAME` into the MCP process using Docker's
`exec -e OPENRIG_SESSION_NAME=<actual-session-name>` option, before the container
name. Configure a separate connection for each seat. Use the identity returned
by attachment or the existing binding, rather than inventing a seat name.

`rig attach --self` can register an existing shell or agent. Outside tmux it is
an `external_cli` attachment. Such an attachment can issue commands and consume
queue work through its own client, but OpenRig cannot send prompts to it,
capture its screen or wake it. Registering an MCP server alone does not attach
a conversation to a seat.

## Let OpenRig launch and manage agents

For automatic launch, message delivery and recovery, use the existing native
runtime adapters with a CLI installed and authenticated in the same execution
environment as the daemon and its tmux sessions. See
[provider setup](getting-started.md#choose-your-providers) and the
[agent runtime settings](agent-spec.md).

### Install a CLI in an isolated Docker environment

A container with a read-only root filesystem can install its selected agent CLI
into the persistent home volume. Keep `/home/node` mounted in that volume and
run the installation as the normal container user. Do not put account credentials
in the image, build context, repository or Compose configuration.

The optional `docker/local-agents/compose.override.yaml` sets the npm installation
prefix to `/home/node/.local` and puts its `bin` directory on the daemon's launch
path. Apply it alongside the existing launch configuration:

```sh
docker compose --project-directory <launch-directory> -f <launch-directory>/compose.yaml -f docker/local-agents/compose.override.yaml up -d --no-build
```

This recreates the service to apply its environment. Preserve the existing home
volume, project mounts and local launch settings. Check for running rigs before
recreating the service. An interactive shell's changed path does not update an
already-running daemon's launch environment.

The override also supplies the existing operator bearer to the local terminal
client through `OPENRIG_TERMINAL_BEARER_TOKEN`. Resolve that value from private
launch settings, never from a committed literal. This lets protected commands
such as `rig send` and `rig capture` authenticate to the isolated daemon.

Use the selected provider's documented npm package and a deliberate version with
`npm install --global` inside the container. The configured prefix keeps the
executable and packages under the persistent home. Check the CLI's version from
a new container execution, then run its normal sign-in command there. A device
authorization flow, when the selected CLI supports it, lets the person sign in
through their host browser without publishing another container port.
Some accounts require enabling device authorization in their security settings
first. After changing that setting, start a fresh login attempt and use its new
code. Keep only one login attempt active at a time.

Run `rig setup --providers <selected-provider> --no-herdr --json` inside the
container to finish the selected provider's setup with plain tmux. An unused
provider is skipped. Verify the CLI's native login status, then check actual
managed-seat readiness and send a small task before reporting the brain ready.
Daemon health or a successful CLI install alone does not prove model access.

A first launch can stop for native hook review. Inspect the pending definitions
and their installed source before trusting them through the CLI's own review
screen. Then run `rig seat continue <actual-session-name> --json` for each seat
whose startup stopped at that gate. A successful continuation delivers the
configured context to the existing conversation. Do not relaunch merely because
startup requires that review. If the provider reports a usage limit, keep the
existing login and conversation; account capacity must recover before another
model task can complete.

The installed executable and login state stay in the home volume across ordinary
container recreation. Deleting that volume removes them. Keep sign-in codes,
tokens, account details and runtime state out of Git and public proof artifacts.

For multiple subscription logins, use the repository's
[local account helper](local-agent-accounts.md). It enrolls each account once,
then switches saved logins for either provider while snapshotting and resuming
affected rigs. It preserves the native conversation store and never logs the
outgoing account out.

A Windows CLI installation and desktop login are not automatically available
inside a Linux container or WSL distribution. Check the CLI's version and native
login status in the environment where the seat will launch. Complete that CLI's
normal sign-in there when required. Native Windows managed seats are currently
unsupported; the Windows installation route for those seats is WSL2.

The MCP connection above provides external client control. It does not add a
transport for automatically launching or waking Windows desktop conversations.

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

A Windows CLI installation and desktop login are not automatically available
inside a Linux container or WSL distribution. Check the CLI's version and native
login status in the environment where the seat will launch. Complete that CLI's
normal sign-in there when required. Native Windows managed seats are currently
unsupported; the Windows installation route for those seats is WSL2.

The MCP connection above provides external client control. It does not add a
transport for automatically launching or waking Windows desktop conversations.

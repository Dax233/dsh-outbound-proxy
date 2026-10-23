# dsh-outbound-proxy

让 DeepSeek Harness 的出站 HTTP(S) 请求走本机 HTTP 代理（Clash / mihomo 等）。端口跟随启动环境，插件行可单独覆盖。

## 安装

```sh
dsh plugin --profile desktop add github:Dax233/dsh-outbound-proxy
```

也可在 DSH 插件页添加该 GitHub 地址，安装后重启 DSH Desktop。

配置见 `INSTALL.md` 与 `env/proxy.env` 示例；默认代理 `http://127.0.0.1:7890`。

---

# @local/dsh-outbound-proxy

Host plugin for DeepSeek Harness that installs an outbound HTTP proxy policy in
the running Host process.

## Why

The Harness resolves its proxy policy once from the launch environment. A
desktop launch without `HTTP_PROXY` / `HTTPS_PROXY` leaves every Node-side
request (`web_fetch`, HTTP MCP transports, account calls) connecting directly.
On a machine whose DNS answers come from a Clash-style fake-IP pool
(`198.18.0.0/15`), `web_fetch` refuses the request before it is sent:

```
URL hostname "www.google.com" resolves to a non-public IP address
```

## What

The plugin calls `installProxyFromEnvironment` from
`@deepseek-ai/dsh-http-proxy` with the configured proxy URL. That replaces
undici's global dispatcher, which `web_fetch` consults through `proxyRouteFor`;
requests then tunnel through the proxy, which resolves the origin itself, so the
local fake-IP answer no longer matters. The installer also publishes the policy
through `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` for child processes.

The module is imported from the Host's own runtime by file URL, so it is the
same instance `web_fetch` already uses — not a second, disconnected copy.
Candidates are derived from the launched script and its ancestor directories
(the desktop Host passes the runtime root as `process.argv[2]`), then resolved
through the runtime's own Node resolution. No installation path is hard-coded.

Loopback traffic always stays direct. Hosts in `noProxy` keep their direct route
(model provider, account API), so stopping the proxy cannot strand a session.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Install the policy at all. Set `false` to leave routes untouched. |
| `proxyUrl` | launch environment, else `http://127.0.0.1:7890` | Local HTTP(S) proxy URL; only `http://` / `https://` are accepted. Leave it out to follow the device. |
| `noProxy` | `deepseek.com,opencode.ai` | Comma-separated direct-connect suffixes. Loopback is always appended. |

Invalid explicit configuration fails activation with a message instead of
silently connecting directly.

## Which port is used

The local mixed port differs per machine and per proxy client (Clash for
Windows defaults to `7890`, Clash Verge to `7897`, others differ again), so the
plugin resolves the URL at mount time instead of baking one port into the
bundle:

1. `config.proxyUrl` in the row — an explicit per-device override, validated;
2. `https_proxy` / `HTTPS_PROXY` / `http_proxy` / `HTTP_PROXY` from the launch
   environment — on the desktop that is `%USERPROFILE%\.dsh\.env`, which the
   launcher reads once at Host start; unusable entries are skipped;
3. `http://127.0.0.1:7890` — the Clash for Windows default, only when neither
   of the above names a proxy.

The Host console line states which one won:

```
[outbound-proxy] installed http://127.0.0.1:7897 (noProxy=deepseek.com,opencode.ai, source=environment:https_proxy)
```

To set another port on a device, either put it in `~/.dsh/.env`
(`env/proxy.env` in this repository is a template) or add `proxyUrl` to the
row — see [INSTALL.md](INSTALL.md).

## Files

- `index.js` — Host plugin (`apply`, URL resolution, validation, module location).
- `cordis.patch.yml` — inserts the `outbound-proxy` row; leaves `proxyUrl` out so
  each device follows its own environment, and sets the direct-connect list
  (`deepseek.com,opencode.ai`).
- `locale/{en,zh}.json` — display title/description.
- `icon.svg` — plugin icon.
- `INSTALL.md` — install/verify/uninstall notes.

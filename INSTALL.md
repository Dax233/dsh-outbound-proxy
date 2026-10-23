# DeepSeek Harness 本机代理修复包（插件版 v1.2.0）

本目录本身就是一个可安装的 Host 插件 bundle（`package.json` 声明
`dsh.bundle.patch`）。与 1.1.0 相比：

- 代理端口不再写死在本仓库里，改为**按设备解析**：显式 `config.proxyUrl`
  > 启动环境 `HTTPS_PROXY` / `HTTP_PROXY`（桌面端即
  `%USERPROFILE%\.dsh\.env`）> 缺省 `http://127.0.0.1:7890`。
  换一台机器、或同一台机器的 Clash 换了端口，都不用改插件代码。
- Host 控制台日志会写明端口来源（`source=config` / `source=environment:…`
  / `source=fallback`），排查时能直接看出用的是哪一个。
- 其余行为（URL 校验、运行时模块定位、安装失败反映到插件激活状态）不变。

## 安装

在 DSH 会话里让 Agent 执行：

```
plugin_manager  action=install_bundle  target=<repo>\outbound-proxy
```

期望返回 `application: applied`（profile 带 HMR 时立即生效，无需重启）。
本地目录安装是**链接**：不要删除或移动本目录，否则插件失效。

## 端口：本机与其它设备

常见的本机混合端口：

| 代理客户端 | 缺省 mixed/HTTP 端口 |
|---|---|
| Clash for Windows | 7890 |
| Clash Verge / verge-mihomo | 7897 |
| 其它客户端 | 看客户端「设置 → 端口」里的 mixed/HTTP 端口 |

插件的解析顺序（先命中先用）：

1. 行配置里的 `config.proxyUrl`（本机显式覆盖，写错会直接报错，不会静默直连）；
2. 启动环境里的 `https_proxy` / `HTTPS_PROXY` / `http_proxy` / `HTTP_PROXY`
   （launcher 启动 Host 时从 `%USERPROFILE%\.dsh\.env` 读取；无法解析或非
   http(s) 的条目会被跳过）；
3. `http://127.0.0.1:7890`（Clash for Windows 缺省值，仅当前两者都没有时使用）。

因此同一份仓库可以装到不同设备上：只要每台设备的 `.env` 或行配置写的是它
自己的端口即可。

### 改端口（两种方式，任选其一）

方式 A（推荐，设备级）：编辑 `%USERPROFILE%\.dsh\.env`，把
`HTTP_PROXY` / `HTTPS_PROXY` 改成实际端口（`env/proxy.env` 是模板），
然后**完全退出并重新打开** DeepSeek Harness（launcher 只在启动时读一次）。
插件随后自动跟随，不需要改仓库、也不需要重装插件。

方式 B（行级覆盖）：编辑本目录 `cordis.patch.yml`，取消 `proxyUrl` 那行的
注释并填端口：

```yaml
- insert:
    - id: outbound-proxy
      name: '@local/dsh-outbound-proxy'
      config:
        enabled: true
        proxyUrl: 'http://127.0.0.1:7897'
        noProxy: 'deepseek.com,opencode.ai'
```

然后 `plugin_manager action=remove_bundle target=@local/dsh-outbound-proxy`，
再 `install_bundle` 重新安装。也可以在 profile 的 `cordis.patch.yml` 里加同 id
覆盖项，避免改仓库文件。

两种方式数值不一致时，显式 `proxyUrl` 优先；建议只保留一处配置。

## 验证

1. 让 Agent 抓 `https://example.com/`、`https://www.google.com/`，应返回 HTTP 200
   （修复前是 `resolves to a non-public IP address`）。
2. `plugin_manager action=list_plugins` 应出现
   `include:outbound-proxy @local/dsh-outbound-proxy enabled=true fiberPhase=active`。
3. 插件日志（Host 控制台）应有下面这样一行，端口与来源应与本机配置一致：

   ```
   [outbound-proxy] installed http://127.0.0.1:7897 (noProxy=deepseek.com,opencode.ai, source=environment:https_proxy)
   ```

## 与 `~/.dsh/.env` 的关系

两条路径互补，都做也不冲突：`.env` 是启动器级（改完需重启 App，但对所有
插件/工具生效），插件是运行时级（随 profile 持久化，可即时生效）。从
v1.2.0 起插件默认**读取** `.env` 里的端口，因此这个仓库不再需要为每台机器
改端口；`.env` 继续作为启动级别的兜底保留即可。若两处端口的写法不同，
以插件行里的显式 `proxyUrl` 为准。

## 卸载

```
plugin_manager action=remove_bundle  target=@local/dsh-outbound-proxy
```

然后按需删除本目录。`.env` 方案的回滚是删掉 `%USERPROFILE%\.dsh\.env` 里对应
三行并重启。

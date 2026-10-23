/**
 * Route DeepSeek Harness outbound HTTP(S) through a local proxy.
 *
 * The Harness resolves its outbound proxy policy once, from the launch
 * environment, before any plugin mounts. A desktop launch without
 * `HTTP_PROXY`/`HTTPS_PROXY` therefore leaves every Node-side request (the
 * `web_fetch` tool, HTTP MCP transports, account calls) connecting directly.
 * On a machine whose system DNS is answered from a Clash-style fake-IP pool
 * (198.18.0.0/15), that direct path is refused by the `web_fetch` SSRF guard:
 * the hostname resolves to a non-public address, so the page is never fetched.
 *
 * This plugin installs the very same policy at runtime through the shipped
 * `@deepseek-ai/dsh-http-proxy` installer, so the running Host starts
 * tunnelling through the configured proxy without a restart. The installer is
 * loaded from the Host's own runtime on purpose: it must be the same module
 * instance `web_fetch` consults through `proxyRouteFor`, and a profile-root
 * copy would be a second, disconnected module.
 *
 * The proxy URL is per-device, so it is resolved instead of baked in: an
 * explicit `config.proxyUrl` wins, otherwise the launch environment's
 * `HTTPS_PROXY` / `HTTP_PROXY` is adopted (that is what
 * `%USERPROFILE%\.dsh\.env` provides, so a Clash/mihomo listening on another
 * port keeps working without editing this bundle), and the Clash-for-Windows
 * default `http://127.0.0.1:7890` is the last resort.
 *
 * Loopback traffic stays direct, and `noProxy` hosts keep their direct route
 * (the model provider lives there, so a stopped proxy cannot strand a session).
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Loader row name used in diagnostics. */
export const name = "outbound-proxy";

/** Runtime package that owns the process-wide dispatcher and route table. */
const PROXY_PACKAGE = "@deepseek-ai/dsh-http-proxy";

/** Entry file inside that package, joined under a runtime root's `node_modules`. */
const PROXY_ENTRY = ["node_modules", "@deepseek-ai", "dsh-http-proxy", "lib", "index.js"];

/** How many parent directories to search for the runtime root. */
const MAX_ANCESTORS = 8;

/** Values used when the bundle row omits a field, so a sparse row still routes. */
const DEFAULTS = Object.freeze({
  enabled: true,
  noProxy: "deepseek.com,opencode.ai",
});

/** Last resort when neither the row nor the launch environment names a proxy. */
const FALLBACK_PROXY_URL = "http://127.0.0.1:7890";

/** Launch-environment names that carry the proxy, in priority order. */
const PROXY_ENV_NAMES = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"];

/**
 * Validate one proxy URL candidate.
 *
 * @param value - candidate text owned by the caller.
 * @param source - where the value came from, for the error message.
 * @returns the trimmed URL.
 */
function requireProxyUrl(value, source) {
  const proxyUrl = value.trim();
  if (proxyUrl === "") throw new Error(`outbound-proxy: ${source} is required and must not be empty`);
  let parsed;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new Error(`outbound-proxy: ${source} is not a valid URL: ${proxyUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`outbound-proxy: ${source} must use http:// or https://, got ${parsed.protocol}//`);
  }
  return proxyUrl;
}

/**
 * Read the first usable proxy URL from the launch environment.
 *
 * The launcher reads `%USERPROFILE%\.dsh\.env` once at Host start, so these
 * variables are the device-level configuration: adopting them keeps the plugin
 * correct when the local proxy listens on a non-default port. Entries the
 * plugin cannot use are skipped — a malformed environment must not make the
 * plugin inert; the explicit config or the fallback still applies.
 *
 * @param env - environment-like map, `process.env` by default.
 * @returns `{ name, value }` for the first http(s) entry, or undefined.
 */
export function proxyUrlFromEnvironment(env = process.env) {
  for (const name of PROXY_ENV_NAMES) {
    const raw = env === null || env === undefined ? undefined : env[name];
    if (typeof raw !== "string" || raw.trim() === "") continue;
    try {
      const parsed = new URL(raw.trim());
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return { name, value: raw.trim() };
    } catch {
      // Not a URL at all; keep looking at the next name.
    }
  }
  return undefined;
}

/**
 * Candidate runtime roots, most specific first.
 *
 * The desktop Host is launched as
 * `<runtime>/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js <runtime> ...`,
 * so `process.argv[2]` is the runtime root (the directory that holds
 * `node_modules/@deepseek-ai/...` and `package.json`). A CLI Host is launched
 * from inside that same tree, so walking up from the launched script finds the
 * directory that contains `node_modules`. The packaged-Electron fallback covers
 * both shapes when argv does not carry the runtime root.
 *
 * @returns candidate directories, in search order, without duplicates.
 */
function runtimeRoots() {
  const roots = [];
  const push = (value) => {
    if (typeof value === "string" && value !== "" && !roots.includes(value)) roots.push(value);
  };
  push(process.argv[2]);
  const launchedScript = process.argv[1];
  if (typeof launchedScript === "string" && launchedScript !== "") {
    let directory = dirname(launchedScript);
    for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
      push(directory);
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  if (typeof process.execPath === "string" && process.execPath !== "") {
    push(join(dirname(process.execPath), "resources", "app.asar", "dsh"));
  }
  return roots;
}

/**
 * Locate the shipped proxy module inside the Host's own runtime.
 *
 * Two strategies run per candidate root: the well-known package layout, then
 * the runtime's own node resolution rooted at that directory, so a package
 * entry that moved inside the runtime is still found. The resolved file is
 * imported by URL later; that URL is what makes the module instance shared with
 * `web_fetch` instead of duplicated.
 *
 * @returns the absolute file of the shipped proxy module, or undefined.
 */
function locateProxyModule() {
  for (const root of runtimeRoots()) {
    const direct = join(root, ...PROXY_ENTRY);
    try {
      if (existsSync(direct)) return direct;
    } catch {
      // An unreadable candidate is simply not the runtime; keep looking.
    }
    try {
      const runtimeRequire = createRequire(pathToFileURL(join(root, "package.json")));
      const resolved = runtimeRequire.resolve(PROXY_PACKAGE);
      if (existsSync(resolved)) return resolved;
    } catch {
      // No package.json or no node_modules under this root; try the next one.
    }
  }
  return undefined;
}

/**
 * Resolve and validate the plugin configuration.
 *
 * Proxy URL resolution order: explicit `config.proxyUrl` (a per-device
 * override), then the launch environment, then the Clash-for-Windows default.
 * Defaults fill omitted fields, but a malformed explicit value is rejected
 * loudly: the shipped installer would silently connect directly for an
 * unsupported scheme, leaving the fake-IP failure in place with no diagnostic
 * in the plugin row. Environment entries are advisory, so unusable ones are
 * skipped by {@link proxyUrlFromEnvironment} instead.
 *
 * @param config - raw row config from the loader.
 * @param env - environment-like map, `process.env` by default.
 * @returns the validated configuration plus the origin of the proxy URL.
 */
export function resolveConfig(config, env = process.env) {
  const raw = config !== null && typeof config === "object" ? config : {};
  const merged = { ...DEFAULTS, ...raw };
  const configured = Object.prototype.hasOwnProperty.call(raw, "proxyUrl") ? raw.proxyUrl : undefined;
  let proxyUrl;
  let source;
  if (configured !== undefined) {
    if (typeof configured !== "string" || configured.trim() === "") {
      throw new Error("outbound-proxy: config.proxyUrl is required and must not be empty");
    }
    proxyUrl = requireProxyUrl(configured, "config.proxyUrl");
    source = "config";
  } else {
    const fromEnvironment = proxyUrlFromEnvironment(env);
    if (fromEnvironment !== undefined) {
      proxyUrl = requireProxyUrl(fromEnvironment.value, `launch environment (${fromEnvironment.name})`);
      source = `environment:${fromEnvironment.name}`;
    } else {
      proxyUrl = FALLBACK_PROXY_URL;
      source = "fallback";
    }
  }
  const noProxy = typeof merged.noProxy === "string" ? merged.noProxy.trim() : "";
  return {
    enabled: merged.enabled !== false,
    proxyUrl,
    noProxy,
    source,
  };
}

/**
 * Build the launch-environment snapshot the shipped installer reads.
 *
 * The installer expects an environment-like map whose entries carry `value`,
 * exactly like the launcher hands it values derived from `process.env`.
 *
 * @param config - validated configuration.
 * @returns proxy variable entries for the installer.
 */
function launchEnvironment(config) {
  const values = new Map();
  values.set("http_proxy", { value: config.proxyUrl });
  values.set("https_proxy", { value: config.proxyUrl });
  if (config.noProxy !== "") values.set("no_proxy", { value: config.noProxy });
  return values;
}

/**
 * Install the proxy policy for this Host process.
 *
 * @param ctx - plugin context; owns the install disposer.
 * @param config - row config from the loader.
 */
export async function apply(ctx, config) {
  const resolved = resolveConfig(config);
  if (!resolved.enabled) {
    console.info("[outbound-proxy] disabled by configuration; leaving outbound routes untouched");
    return;
  }
  const moduleFile = locateProxyModule();
  if (moduleFile === undefined) {
    throw new Error(
      `outbound-proxy: cannot locate ${PROXY_PACKAGE} in this Host runtime (searched: ${runtimeRoots().join(", ")})`,
    );
  }
  const proxy = await import(pathToFileURL(moduleFile).href);
  if (typeof proxy.installProxyFromEnvironment !== "function") {
    throw new Error(
      `outbound-proxy: ${PROXY_PACKAGE} at ${moduleFile} does not export installProxyFromEnvironment`,
    );
  }
  const install = proxy.installProxyFromEnvironment(launchEnvironment(resolved), (message) => {
    console.warn(`[outbound-proxy] ${message}`);
  });
  // Register the disposer before awaiting so an unload during installation
  // still releases a policy that finishes installing afterwards.
  ctx.effect(() => {
    let disposed = false;
    let release;
    install.then(
      (value) => {
        if (disposed) void value();
        else release = value;
      },
      () => {
        // Installation failure is reported by the awaited install below.
      },
    );
    return () => {
      disposed = true;
      if (release !== undefined) return release();
    };
  }, "outbound-proxy.install");
  await install;
  const canary = proxy.proxyRouteFor(new URL("https://example.invalid/"));
  if (!canary.proxied) {
    console.warn(
      "[outbound-proxy] policy installed but https://example.invalid/ is still routed direct; check noProxy",
    );
  }
  console.info(
    `[outbound-proxy] installed ${resolved.proxyUrl} (noProxy=${
      resolved.noProxy === "" ? "<none>" : resolved.noProxy
    }, source=${resolved.source})`,
  );
}

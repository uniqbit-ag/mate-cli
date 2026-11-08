import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";

interface RtkLocationOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  readConfig?: (file: string) => Promise<string>;
}

async function readConfig(file: string): Promise<string> {
  try {
    if ((await stat(file)).size > 1024 * 1024) throw new Error("RTK config exceeds limit");
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** Platform data and config base directories, as RTK resolves them. */
function platformDirectories(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
): { data: string; config: string } {
  if (platform === "darwin") {
    const data = path.posix.join(home, "Library", "Application Support");
    return { data, config: data };
  }
  if (platform === "win32")
    return {
      data: env.LOCALAPPDATA ?? path.win32.join(home, "AppData", "Local"),
      config: env.APPDATA ?? path.win32.join(home, "AppData", "Roaming"),
    };
  return {
    data: env.XDG_DATA_HOME ?? path.posix.join(home, ".local", "share"),
    config: env.XDG_CONFIG_HOME ?? path.posix.join(home, ".config"),
  };
}

/** RTK precedence: explicit environment path, tracking.database_path, platform data directory. */
export async function resolveRtkDatabase(options: RtkLocationOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  if (env.RTK_DB_PATH !== undefined) {
    if (!env.RTK_DB_PATH) throw new Error("RTK database override is empty");
    return env.RTK_DB_PATH;
  }
  const paths = platform === "win32" ? path.win32 : path.posix;
  const { data, config } = platformDirectories(platform, home, env);
  const document = parse(
    await (options.readConfig ?? readConfig)(paths.join(config, "rtk", "config.toml")),
  );
  const tracking = document.tracking;
  const database =
    tracking &&
    typeof tracking === "object" &&
    !Array.isArray(tracking) &&
    "database_path" in tracking
      ? tracking.database_path
      : undefined;
  if (database !== undefined) {
    if (typeof database !== "string" || !database)
      throw new Error("RTK database config is invalid");
    return database;
  }
  return paths.join(data, "rtk", "history.db");
}

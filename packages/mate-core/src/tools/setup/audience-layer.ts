// oxlint-disable no-await-in-loop
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { getActiveDistribution } from "../../distribution";
import type { FrameworkConfig } from "../../lib/orchestrator/types";
import {
  audienceLayerDir,
  audienceLayersRoot,
  CURRENT_LAYER_LINK,
} from "../../runtime/audience-layer";
import {
  dynamicPluginsWorkspaceRoot,
  pluginLocalOverridesPath,
  pluginPackageRoot,
} from "./dynamic-plugins/paths";
import { loadAudienceRegistrations } from "./audience-registrations";
import {
  buildSetupInstallationPlan,
  collectAudienceInputs,
  RUNTIME_SURFACE_RECONCILERS,
} from "./engine";
import type { PluginRegistration, SetupContext } from "./plugin";
import type { NormalizedRegistration } from "./registry";
import { projectionTarget } from "./surface-target";

/**
 * Writes the active audience's layer through each runtime's Runtime Surface,
 * under the pass's layer root only. Refuses any other target, and a pass that
 * names no audience.
 */
export async function reconcileAudienceLayer(
  ctx: SetupContext,
  registrations: PluginRegistration[],
): Promise<void> {
  if (projectionTarget(ctx) !== "audience-layer") {
    throw new Error("an audience layer is reconciled with the audience-layer target only");
  }
  for (const [runtimeId, inputs] of await collectAudienceInputs(
    ctx,
    registrations,
    ctx.audience!,
  )) {
    const reconcile = RUNTIME_SURFACE_RECONCILERS[runtimeId];
    if (!reconcile || inputs.length === 0) continue;
    await reconcile(ctx, inputs);
  }
}

/** Bumped when the layout a layer pass writes changes, so old layers are re-rendered. */
const LAYER_FORMAT = 1;

/** A render that never finished, or a superseded layer, is left this long for sessions still reading it. */
const STALE_LAYER_MS = 24 * 60 * 60 * 1000;

const FINGERPRINT_FILE = ".fingerprint";

export interface AudienceLayerRequest {
  companionPath: string;
  config: FrameworkConfig;
  audience: string;
  /** The Agent Runtimes the layer is rendered for. */
  activeProviders: string[];
  /** The process's registrations; only the audience's own are rendered. */
  registrations: PluginRegistration[];
  homeDir?: string;
}

export interface RenderedAudienceLayer {
  audience: string;
  /** The complete layer a launch attaches; never changed once in place. */
  root: string;
  /** False when an unchanged layer was reused. */
  rendered: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The installed version of each package, from the committed lockfile, else the installed manifest. */
async function lockedVersions(
  companionPath: string,
  packages: string[],
): Promise<Record<string, string | null>> {
  const lock = await fs
    .readFile(path.join(dynamicPluginsWorkspaceRoot(companionPath), "package-lock.json"), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  const lockPackages = isRecord(lock) && isRecord(lock.packages) ? lock.packages : {};
  const versions: Record<string, string | null> = {};
  for (const name of packages.toSorted()) {
    const locked = lockPackages[`node_modules/${name}`];
    if (isRecord(locked) && typeof locked.version === "string") {
      versions[name] = locked.version;
      continue;
    }
    const manifest = await fs
      .readFile(path.join(pluginPackageRoot(companionPath, name), "package.json"), "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => null);
    versions[name] =
      isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : null;
  }
  return versions;
}

/**
 * What a layer depends on: the audience's declaration, the installed versions
 * of its packages, the local plugin overrides, the Mate version and the active
 * runtimes. Anything else changing leaves the layer as it is.
 */
async function audienceLayerFingerprint(request: AudienceLayerRequest): Promise<string> {
  const entry = request.config.audiences?.[request.audience] ?? null;
  const packages = (entry?.plugins ?? []).map((declaration) => declaration.package);
  const overrides = await fs
    .readFile(pluginLocalOverridesPath(request.companionPath), "utf8")
    .catch(() => null);
  const inputs = {
    format: LAYER_FORMAT,
    audience: request.audience,
    entry,
    versions: await lockedVersions(request.companionPath, packages),
    overrides,
    mate: getActiveDistribution().config.version,
    runtimes: [...new Set(request.activeProviders)].toSorted(),
  };
  return crypto.createHash("sha256").update(JSON.stringify(inputs)).digest("hex").slice(0, 24);
}

async function exists(target: string): Promise<boolean> {
  return fs
    .access(target)
    .then(() => true)
    .catch(() => false);
}

/** Points `current` at `fingerprint` with one rename, so a reader never finds it missing. */
async function pointCurrentAt(dir: string, fingerprint: string): Promise<void> {
  const link = path.join(dir, CURRENT_LAYER_LINK);
  if ((await fs.readlink(link).catch(() => null)) === fingerprint) return;
  const staged = path.join(dir, `.${CURRENT_LAYER_LINK}-${crypto.randomUUID()}`);
  await fs.symlink(fingerprint, staged);
  await fs.rename(staged, link);
}

/** Superseded layers and abandoned renders, once no session can still be starting from them. */
async function pruneStaleLayers(dir: string, keep: string): Promise<void> {
  const now = Date.now();
  for (const name of await fs.readdir(dir).catch(() => [])) {
    /** Launch settings files live here too; each launch rewrites its own. */
    if (name === keep || name === CURRENT_LAYER_LINK || name.startsWith("launch-")) continue;
    const target = path.join(dir, name);
    const stat = await fs.lstat(target).catch(() => null);
    if (!stat || now - stat.mtimeMs < STALE_LAYER_MS) continue;
    await fs.rm(target, { recursive: true, force: true });
  }
}

/** Creates the layers root and every level below it for the current user only. */
async function ensurePrivateDir(root: string, dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  for (let level = dir; level.startsWith(root); level = path.dirname(level)) {
    await fs.chmod(level, 0o700);
    if (level === root) break;
  }
}

/**
 * Renders the audience's layer, or reuses it when nothing it depends on
 * changed. A render is built in a private staging directory and renamed into a
 * directory named by its fingerprint, so a reader sees a complete layer or
 * none; concurrent renders of the same inputs agree on one result.
 */
export async function renderAudienceLayer(
  request: AudienceLayerRequest,
): Promise<RenderedAudienceLayer> {
  const dir = audienceLayerDir(request.companionPath, request.audience, request.homeDir);
  const fingerprint = await audienceLayerFingerprint(request);
  const root = path.join(dir, fingerprint);

  await ensurePrivateDir(audienceLayersRoot(request.homeDir), dir);
  if (await exists(path.join(root, FINGERPRINT_FILE))) {
    await pointCurrentAt(dir, fingerprint);
    return { audience: request.audience, root, rendered: false };
  }

  const staging = await fs.mkdtemp(path.join(dir, ".render-"));
  try {
    await reconcileAudienceLayer(
      {
        companionPath: request.companionPath,
        config: request.config,
        mode: "sync",
        activeProviders: request.activeProviders,
        target: "audience-layer",
        audience: request.audience,
        layerRoot: staging,
      },
      request.registrations,
    );
    await fs.writeFile(path.join(staging, FINGERPRINT_FILE), `${fingerprint}\n`, "utf8");
    await fs.rename(staging, root);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    /** Another launch renamed the same inputs into place first: its layer is this one. */
    if (!(await exists(path.join(root, FINGERPRINT_FILE)))) throw error;
  }
  await pointCurrentAt(dir, fingerprint);
  await pruneStaleLayers(dir, fingerprint);
  return { audience: request.audience, root, rendered: true };
}

export interface EnsuredAudienceLayer extends RenderedAudienceLayer {
  /** The audience's registrations the layer was rendered from. */
  registrations: NormalizedRegistration[];
  /** Declarations that could not be loaded; the layer renders without them. */
  warnings: string[];
}

/**
 * The audience's layer, rendered or reused: the one way a launch or a wrap
 * gets one. The fingerprint does not cover the registrations, so every caller
 * must render from the same ones; sourcing them here makes that so. They are
 * loaded for their declarations only, reusing a plugin this process hydrated,
 * and rendered for the runtimes the companion's base set activates.
 */
export async function ensureAudienceLayer(request: {
  companionPath: string;
  config: FrameworkConfig;
  audience: string;
}): Promise<EnsuredAudienceLayer> {
  const { companionPath, config, audience } = request;
  const registry = getActiveDistribution().registry;
  const loaded = await loadAudienceRegistrations(companionPath, config, audience, registry);
  const layer = await renderAudienceLayer({
    companionPath,
    config,
    audience,
    activeProviders: buildSetupInstallationPlan(config, registry.baseRegistrations())
      .activeProviders,
    registrations: loaded.registrations,
  });
  return { ...layer, registrations: loaded.registrations, warnings: loaded.warnings };
}

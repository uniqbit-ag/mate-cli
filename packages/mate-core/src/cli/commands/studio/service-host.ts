import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { errorMessage } from "../../../runtime/error-message";
import { SERVICE_API_VERSION } from "../../../tools/setup/service-registry";
import type {
  PluginService,
  ServiceConnection,
  StudioCompanionSource,
  StudioRoute,
  StudioRouteAccess,
  StudioServiceContribution,
  StudioServiceHost,
  StudioWorksetSessions,
} from "../../../tools/setup/service";
import { SERVICE_ASSET_PREFIX, SERVICE_ROUTE_PREFIX } from "./routes";

/** A service's view as Studio's navigation lists it; carries no path. */
export interface StudioServiceViewSummary {
  id: string;
  label: string;
  description?: string;
  /** Where the view's module is served from, when the service ships one. */
  moduleUrl?: string;
}

/** A mounted service as Studio's application sees it. */
export interface StudioServiceSummary {
  id: string;
  label: string;
  views: StudioServiceViewSummary[];
}

interface MountedService {
  service: PluginService;
  contribution: StudioServiceContribution;
}

/** A route of a mounted service matched to a request. */
export interface MatchedServiceRoute {
  route: StudioRoute;
  /** The path below the service prefix. */
  path: string;
  /** `null`: the route does not serve the method. */
  access: StudioRouteAccess | null;
  methods: string[];
}

/** The services one Studio server mounted, with what core asks of them. */
export interface MountedServices {
  summaries(): StudioServiceSummary[];
  /** The route of `/api/plugins/<id>/…` a pathname names; `null` when none does. */
  match(pathname: string, method: string): MatchedServiceRoute | null;
  /** A file of a view module, `/studio/plugins/<id>/<view>/<file>`; `null` when none. */
  asset(pathname: string): Promise<Response | null>;
  worksetSessions: StudioWorksetSessions | null;
  companions: StudioCompanionSource | null;
  pinnedCompanions(): string[];
  close(): Promise<void>;
}

/** The host every service gets, without its own connection. */
export type StudioServiceHostBase = Omit<StudioServiceHost, "apiVersion" | "connection">;

function connectionOf(service: PluginService, env: NodeJS.ProcessEnv): ServiceConnection | null {
  return service.connection ? service.connection(env) : null;
}

/**
 * Mounts each service whose daemon is there (or that declares none): calls its `studio` with
 * the host. A service that throws is left out with a warning; Studio keeps serving.
 */
export async function mountStudioServices(
  services: readonly PluginService[],
  host: StudioServiceHostBase,
  warn: (message: string) => void = (message) => process.stderr.write(`mate studio: ${message}\n`),
): Promise<MountedServices> {
  const mounted: MountedService[] = [];
  for (const service of services) {
    try {
      const connection = connectionOf(service, host.env);
      if (service.connection && connection === null) continue;
      // oxlint-disable-next-line no-await-in-loop -- registration order decides who owns a hook
      const contribution = await service.studio?.({
        ...host,
        apiVersion: SERVICE_API_VERSION,
        connection,
      });
      if (contribution) mounted.push({ service, contribution });
    } catch (error) {
      warn(`the ${service.label} service did not start: ${errorMessage(error)}`);
    }
  }
  return mountedServices(mounted);
}

/** No service mounted: what a Studio without plugins serves. */
export const NO_SERVICES: MountedServices = mountedServices([]);

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/** `rest` below `dir`, or `null` when it leaves it (also through a link). */
async function fileWithin(dir: string, rest: string): Promise<string | null> {
  if (!rest || rest.split("/").some((part) => part === ".." || part === "")) return null;
  try {
    const root = await realpath(dir);
    const file = await realpath(path.join(root, rest));
    return file.startsWith(`${root}${path.sep}`) ? file : null;
  } catch {
    return null;
  }
}

function routeMatches(route: StudioRoute, rest: string): boolean {
  if (route.path.endsWith("/*")) {
    const base = route.path.slice(0, -2);
    return rest === base || rest.startsWith(`${base}/`);
  }
  return rest === route.path;
}

function mountedServices(mounted: MountedService[]): MountedServices {
  const byId = new Map(mounted.map((entry) => [entry.service.id, entry]));
  const first = <T>(pick: (contribution: StudioServiceContribution) => T | undefined): T | null =>
    mounted.map((entry) => pick(entry.contribution)).find((value) => value !== undefined) ?? null;
  return {
    summaries: () =>
      mounted.map(({ service, contribution }) => ({
        id: service.id,
        label: service.label,
        views: (contribution.views ?? []).map((view) => ({
          id: view.id,
          label: view.label,
          ...(view.description ? { description: view.description } : {}),
          ...(view.module
            ? {
                moduleUrl: `${SERVICE_ASSET_PREFIX}${service.id}/${view.id}/${view.module.entry}`,
              }
            : {}),
        })),
      })),
    match(pathname, method) {
      if (!pathname.startsWith(SERVICE_ROUTE_PREFIX)) return null;
      const tail = pathname.slice(SERVICE_ROUTE_PREFIX.length);
      const slash = tail.indexOf("/");
      const entry = byId.get(slash === -1 ? tail : tail.slice(0, slash));
      if (!entry) return null;
      const rest = slash === -1 ? "/" : tail.slice(slash);
      const route = entry.contribution.routes?.find((candidate) => routeMatches(candidate, rest));
      if (!route) return null;
      const methods = Object.keys(route.methods);
      if (methods.includes("GET")) methods.push("HEAD");
      const key = method === "HEAD" ? "GET" : method;
      const access = route.methods[key as keyof StudioRoute["methods"]] ?? null;
      return { route, path: rest, access, methods };
    },
    async asset(pathname) {
      if (!pathname.startsWith(SERVICE_ASSET_PREFIX)) return null;
      const [id, viewId, ...rest] = pathname.slice(SERVICE_ASSET_PREFIX.length).split("/");
      const view = byId
        .get(id ?? "")
        ?.contribution.views?.find((candidate) => candidate.id === viewId);
      if (!view?.module) return null;
      const file = await fileWithin(view.module.dir, rest.join("/"));
      if (!file) return null;
      try {
        return new Response(await readFile(file), {
          headers: {
            "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
            "cache-control": "no-cache",
            "x-content-type-options": "nosniff",
          },
        });
      } catch {
        return null;
      }
    },
    worksetSessions: first((contribution) => contribution.worksetSessions),
    companions: first((contribution) => contribution.companions),
    pinnedCompanions: () => mounted.flatMap((entry) => entry.contribution.pinnedCompanions ?? []),
    async close() {
      await Promise.all(mounted.map((entry) => entry.contribution.close?.().catch(() => {})));
    },
  };
}

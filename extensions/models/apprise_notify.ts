/**
 * Apprise notifier — send a notification through an
 * {@link https://github.com/caronc/apprise-api | Apprise API} server.
 *
 * Apprise fans one HTTP call out to 100+ services (Matrix, Discord, ntfy,
 * email, Slack, ...), so a homelab only has to teach swamp about Apprise rather
 * than about every notifier behind it.
 *
 * Two design decisions are worth reading before use, both driven by how the
 * Apprise API actually behaves rather than by taste:
 *
 * 1. **`when` exists because swamp workflows cannot branch.** A workflow's
 *    `dependsOn.condition` only understands dependency *state* — `succeeded`,
 *    `failed`, `skipped` and boolean combinations of those — so there is no way
 *    to express "only run this step if the previous step changed something".
 *    Passing that predicate in as `when` moves the decision inside the model,
 *    which is the only place it can live.
 *
 * 2. **HTTP 204 is treated as a failure.** Apprise answers `204 No Content`
 *    when the config key does not exist, having notified precisely nobody. A
 *    typo in `configKey` is otherwise indistinguishable from success, which is
 *    the worst possible failure mode for an alerting path — you find out when
 *    the alert you were relying on never arrives.
 *
 * @module
 */
// extensions/models/apprise_notify.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  apiUrl: z.string().url().describe(
    "Base URL of the Apprise API server, e.g. http://apprise:8000",
  ),
  configKey: z.string().optional().describe(
    "Persistent config key to notify (POST /notify/<key>). Omit to use stateless mode, which requires `urls`.",
  ),
  urls: z.string().optional().describe(
    "Stateless mode: comma-separated Apprise URLs to notify directly (POST /notify). Ignored when configKey is set.",
  ),
  defaultTags: z.string().optional().describe(
    "Comma-separated tags applied when a notify call does not specify its own. Must match tags on the configured URLs or nothing is sent.",
  ),
  timeoutMs: z.number().int().positive().default(10000).describe(
    "Abort the notification attempt after this long. Notifications should never hang a workflow.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const NotificationSchema = z.object({
  delivered: z.boolean().describe(
    "True when Apprise accepted the notification and dispatched it to at least one target",
  ),
  skipped: z.boolean().describe(
    "True when `when` was false, so no request was made at all",
  ),
  title: z.string(),
  type: z.string(),
  tags: z.string().nullable(),
  status: z.number().nullable().describe(
    "HTTP status Apprise returned, or null when the call was skipped",
  ),
  sentAt: z.string(),
});

type Logger = {
  info: (message: string, props?: Record<string, unknown>) => void;
  warn: (message: string, props?: Record<string, unknown>) => void;
};

/**
 * Strip credentials out of anything echoed back from Apprise.
 *
 * In stateless mode the request carries Apprise URLs inline, and those embed
 * secrets — `matrixs://user:token@host/room`. Apprise's error responses quote
 * the URLs it tried, so relaying the body verbatim would write a live token
 * into the run log and any alert built on top of it. Config-key mode never
 * carries a secret in the first place; this exists for the mode that does.
 */
function redact(text: string): string {
  // Any scheme with a userinfo component: keep the shape, drop the secret.
  return text.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^\s/@"']+@/gi,
    "$1<redacted>@",
  );
}

/**
 * Resolve the endpoint and the identifying half of the payload.
 *
 * Apprise has two mutually exclusive modes: a stored config addressed by key,
 * or a stateless call carrying its URLs inline. Mixing them silently ignores
 * one, so this refuses rather than guesses.
 */
function resolveTarget(
  globalArgs: GlobalArgs,
): { url: string; extra: Record<string, unknown> } {
  const base = globalArgs.apiUrl.replace(/\/+$/, "");

  if (globalArgs.configKey) {
    return { url: `${base}/notify/${globalArgs.configKey}`, extra: {} };
  }
  if (globalArgs.urls) {
    return { url: `${base}/notify`, extra: { urls: globalArgs.urls } };
  }
  throw new Error(
    "Configure either `configKey` (stored Apprise config) or `urls` (stateless mode); neither was set.",
  );
}

/**
 * Model type `@sntxrr/apprise-notify`.
 *
 * A single `notify` method that posts a title/body to an Apprise API server.
 *
 * @example
 * ```bash
 * swamp model create @sntxrr/apprise-notify apprise
 * swamp model @sntxrr/apprise-notify method run notify apprise \
 *   --arg title="Hello" --arg body="From swamp"
 * ```
 */
export const model = {
  type: "@sntxrr/apprise-notify",
  description:
    "Send notifications through an Apprise API server, fanning out to Matrix, Discord, ntfy, email and 100+ other services",
  version: "2026.07.30.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "notification": {
      description:
        "Record of a notification attempt: whether it was delivered, skipped, and what Apprise said",
      schema: NotificationSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },
  methods: {
    notify: {
      description:
        "Post a notification to Apprise, optionally gated on a caller-supplied condition",
      arguments: z.object({
        title: z.string().min(1).describe("Notification title"),
        body: z.string().min(1).describe(
          "Notification body. Honours `format` — use markdown for Matrix and Discord.",
        ),
        type: z.enum(["info", "success", "warning", "failure"]).default("info")
          .describe(
            "Severity. Most targets render this as a colour or icon.",
          ),
        tags: z.string().optional().describe(
          "Comma-separated tags selecting which configured URLs to notify. Falls back to defaultTags.",
        ),
        format: z.enum(["text", "markdown", "html"]).default("text").describe(
          "Body format passed to Apprise",
        ),
        when: z.boolean().default(true).describe(
          "Send only when true. Exists because swamp workflows cannot express predicate conditions — pass a CEL expression here instead.",
        ),
      }),
      execute: async (
        args: {
          title: string;
          body: string;
          type: "info" | "success" | "warning" | "failure";
          tags?: string;
          format: "text" | "markdown" | "html";
          when: boolean;
        },
        context: {
          globalArgs: GlobalArgs;
          logger: Logger;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const { globalArgs, logger } = context;
        const tags = args.tags ?? globalArgs.defaultTags ?? null;

        // Skipping is a first-class outcome, not an error: the common case is a
        // workflow step that runs every tick but should only speak up on change.
        if (!args.when) {
          logger.info("Condition was false; not sending {title}", {
            title: args.title,
          });
          const handle = await context.writeResource(
            "notification",
            "current",
            {
              delivered: false,
              skipped: true,
              title: args.title,
              type: args.type,
              tags,
              status: null,
              sentAt: new Date().toISOString(),
            },
          );
          return { dataHandles: [handle] };
        }

        const { url, extra } = resolveTarget(globalArgs);
        const payload: Record<string, unknown> = {
          title: args.title,
          body: args.body,
          type: args.type,
          format: args.format,
          ...extra,
        };
        if (tags) payload.tag = tags;

        // Apprise reaches out to third-party services synchronously, so a dead
        // target can hang the request. A workflow step must not wait forever on
        // a notification.
        const signal = AbortSignal.timeout(globalArgs.timeoutMs);
        let res: Response;
        try {
          res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal,
          });
        } catch (cause) {
          const reason = cause instanceof Error && cause.name === "TimeoutError"
            ? `timed out after ${globalArgs.timeoutMs}ms`
            : String(cause);
          throw new Error(`Apprise POST ${url} failed: ${reason}`);
        }

        const text = await res.text();

        // 204 means "no such config key". Apprise notified nobody and still
        // reports a 2xx, so a typo would otherwise pass silently forever.
        if (res.status === 204) {
          throw new Error(
            `Apprise returned 204 No Content for ${url} — the config key ` +
              `"${globalArgs.configKey}" does not exist on that server, so nothing was sent. ` +
              `Check the key, or use stateless mode with \`urls\`.`,
          );
        }

        if (!res.ok) {
          // 424 is the everyday one: the tag matched none of the configured
          // URLs, so there was nothing to notify.
          const hint = res.status === 424 && tags
            ? ` — no configured URL carries tag "${tags}"`
            : "";
          throw new Error(
            `Apprise POST ${url} failed: ${res.status}${hint} ${redact(text)}`,
          );
        }

        logger.info("Notified {title} via {url}", {
          title: args.title,
          url,
        });

        const handle = await context.writeResource("notification", "current", {
          delivered: true,
          skipped: false,
          title: args.title,
          type: args.type,
          tags,
          status: res.status,
          sentAt: new Date().toISOString(),
        });

        return { dataHandles: [handle] };
      },
    },
  },
};

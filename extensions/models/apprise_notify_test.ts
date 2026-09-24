// extensions/models/apprise_notify_test.ts
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing";
import { model } from "./apprise_notify.ts";

type NotifyContext = Parameters<typeof model.methods.notify.execute>[1];

const GLOBAL_ARGS = {
  apiUrl: "http://apprise:8000",
  configKey: "homelab",
  defaultTags: "homelab",
  timeoutMs: 10000,
};

function notifyContext(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const ctx = createModelTestContext({ globalArgs, methodName: "notify" });
  return { ...ctx, context: ctx.context as unknown as NotifyContext };
}

const ARGS = {
  title: "Home IP changed",
  body: "198.51.100.4 -> 203.0.113.7",
  type: "info" as const,
  format: "text" as const,
  when: true,
};

/** Capture every request and reply with a caller-chosen status. */
function capture(status: number, body = "") {
  const seen: Array<{ url: string; method: string; payload: unknown }> = [];
  const handler = async (req: Request): Promise<Response> => {
    seen.push({
      url: req.url,
      method: req.method,
      payload: JSON.parse(await req.text()),
    });
    return new Response(body || null, { status });
  };
  return { handler, seen };
}

Deno.test("notify posts to the config-key endpoint and records delivery", async () => {
  const { context, getWrittenResources } = notifyContext();
  const { handler, seen } = capture(200, '{"error":null}');

  await withMockedFetch(handler, async () => {
    await model.methods.notify.execute(ARGS, context);
  });

  assertEquals(seen.length, 1);
  assertEquals(seen[0].url, "http://apprise:8000/notify/homelab");
  assertEquals(seen[0].method, "POST");

  const payload = seen[0].payload as Record<string, unknown>;
  assertEquals(payload.title, "Home IP changed");
  assertEquals(payload.tag, "homelab", "defaultTags must be applied");

  const resource = getWrittenResources()[0].data;
  assertEquals(resource.delivered, true);
  assertEquals(resource.skipped, false);
  assertEquals(resource.status, 200);
});

Deno.test("when=false sends nothing and records a skip", async () => {
  const { context, getWrittenResources } = notifyContext();
  const { handler, seen } = capture(200);

  await withMockedFetch(handler, async () => {
    await model.methods.notify.execute({ ...ARGS, when: false }, context);
  });

  assertEquals(seen.length, 0, "a false condition must not issue a request");

  const resource = getWrittenResources()[0].data;
  assertEquals(resource.skipped, true);
  assertEquals(resource.delivered, false);
  assertEquals(resource.status, null);
});

Deno.test("204 is treated as failure, not success", async () => {
  // Apprise answers 204 when the config key does not exist, having notified
  // nobody. Passing that through as success is the whole bug this guards.
  const { context } = notifyContext();
  const { handler } = capture(204);

  let err!: Error;
  await withMockedFetch(handler, async () => {
    err = await assertRejects(
      () => model.methods.notify.execute(ARGS, context),
      Error,
    );
  });

  assertStringIncludes(err.message, "204");
  assertStringIncludes(err.message, "does not exist");
});

Deno.test("424 explains that no URL carries the tag", async () => {
  const { context } = notifyContext();
  const { handler } = capture(
    424,
    '{"error": "One or more notification could not be sent"}',
  );

  let err!: Error;
  await withMockedFetch(handler, async () => {
    err = await assertRejects(
      () => model.methods.notify.execute({ ...ARGS, tags: "nope" }, context),
      Error,
    );
  });

  assertStringIncludes(err.message, "424");
  assertStringIncludes(err.message, 'no configured URL carries tag "nope"');
});

Deno.test("stateless mode posts to /notify and inlines the urls", async () => {
  const { context } = notifyContext({
    apiUrl: "http://apprise:8000",
    urls: "matrixs://user:pass@host/room",
    timeoutMs: 10000,
  });
  const { handler, seen } = capture(200);

  await withMockedFetch(handler, async () => {
    await model.methods.notify.execute(ARGS, context);
  });

  assertEquals(seen[0].url, "http://apprise:8000/notify");
  const payload = seen[0].payload as Record<string, unknown>;
  assertEquals(payload.urls, "matrixs://user:pass@host/room");
});

Deno.test("explicit tags override defaultTags", async () => {
  const { context } = notifyContext();
  const { handler, seen } = capture(200);

  await withMockedFetch(handler, async () => {
    await model.methods.notify.execute(
      { ...ARGS, tags: "deployment,vps" },
      context,
    );
  });

  assertEquals(
    (seen[0].payload as Record<string, unknown>).tag,
    "deployment,vps",
  );
});

Deno.test("configuring neither configKey nor urls is rejected", async () => {
  const { context } = notifyContext({
    apiUrl: "http://apprise:8000",
    timeoutMs: 10000,
  });
  const { handler } = capture(200);

  let err!: Error;
  await withMockedFetch(handler, async () => {
    err = await assertRejects(
      () => model.methods.notify.execute(ARGS, context),
      Error,
    );
  });

  assertStringIncludes(err.message, "configKey");
  assertStringIncludes(err.message, "urls");
});

Deno.test("credentials in an echoed error body are redacted", async () => {
  // Stateless mode puts real secrets in the request, and Apprise quotes the
  // URLs it tried back in its error body. Relaying that verbatim would write a
  // live token into the run log.
  const { context } = notifyContext({
    apiUrl: "http://apprise:8000",
    urls: "matrixs://alice:sup3rs3cret@matrix.example/room",
    timeoutMs: 10000,
  });
  const { handler } = capture(
    424,
    '{"error":"failed","details":"matrixs://alice:sup3rs3cret@matrix.example/room"}',
  );

  let err!: Error;
  await withMockedFetch(handler, async () => {
    err = await assertRejects(
      () => model.methods.notify.execute(ARGS, context),
      Error,
    );
  });

  assertStringIncludes(err.message, "<redacted>@matrix.example");
  assertEquals(
    err.message.includes("sup3rs3cret"),
    false,
    "the token must never reach the error message",
  );
});

Deno.test("a trailing slash on apiUrl does not produce a double slash", async () => {
  const { context } = notifyContext({
    ...GLOBAL_ARGS,
    apiUrl: "http://apprise:8000/",
  });
  const { handler, seen } = capture(200);

  await withMockedFetch(handler, async () => {
    await model.methods.notify.execute(ARGS, context);
  });

  assertEquals(seen[0].url, "http://apprise:8000/notify/homelab");
});

const BY_TYPE = {
  ...GLOBAL_ARGS,
  tagsByType: { failure: "homelab,alert", success: "homelab,done" },
};

for (
  const [type, want] of [
    ["failure", "homelab,alert"],
    ["success", "homelab,done"],
    ["warning", "homelab"], // unmapped: falls back to defaultTags
    ["info", "homelab"],
  ] as const
) {
  Deno.test(`tagsByType routes type=${type} to "${want}"`, async () => {
    const { context, getWrittenResources } = notifyContext(BY_TYPE);
    const { handler, seen } = capture(200);

    await withMockedFetch(handler, async () => {
      await model.methods.notify.execute({ ...ARGS, type }, context);
    });

    assertEquals((seen[0].payload as Record<string, unknown>).tag, want);
    assertEquals(getWrittenResources()[0].data.tags, want);
  });
}

Deno.test("explicit tags override tagsByType", async () => {
  const { context } = notifyContext(BY_TYPE);
  const { handler, seen } = capture(200);

  await withMockedFetch(handler, async () => {
    await model.methods.notify.execute(
      { ...ARGS, type: "failure", tags: "custom" },
      context,
    );
  });

  assertEquals((seen[0].payload as Record<string, unknown>).tag, "custom");
});

Deno.test("an empty tagsByType entry falls back instead of sending untagged", async () => {
  const { context } = notifyContext({
    ...GLOBAL_ARGS,
    tagsByType: { failure: "" },
  });
  const { handler, seen } = capture(200);

  await withMockedFetch(handler, async () => {
    await model.methods.notify.execute({ ...ARGS, type: "failure" }, context);
  });

  assertEquals((seen[0].payload as Record<string, unknown>).tag, "homelab");
});

Deno.test("the 2026.09.24.1 upgrade carries existing arguments over unchanged", () => {
  const upgrade = model.upgrades.find((u) => u.toVersion === model.version);
  assertEquals(upgrade?.upgradeAttributes({ ...GLOBAL_ARGS }), GLOBAL_ARGS);
});

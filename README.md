# swamp-apprise

Swamp extension providing **`@sntxrr/apprise-notify`** — send notifications
through an [Apprise API](https://github.com/caronc/apprise-api) server.

Apprise fans a single HTTP call out to 100+ services (Matrix, Discord, ntfy,
Slack, email, Pushover), so swamp only has to learn about Apprise instead of
about every notifier behind it. Point this at a self-hosted `apprise-api`
container and every workflow gets notifications.

| | |
| --- | --- |
| Model | [`extensions/models/apprise_notify.ts`](extensions/models/apprise_notify.ts) |
| Docs | [`extensions/models/README.md`](extensions/models/README.md) |
| Tests | `deno test --allow-all extensions/models/apprise_notify_test.ts` |
| Quality | `swamp extension quality extensions/models/manifest.yaml` |

## Quick start

```bash
swamp model create @sntxrr/apprise-notify apprise \
  --global-arg 'apiUrl=http://apprise:8000' \
  --global-arg 'configKey=homelab' \
  --global-arg 'defaultTags=homelab'

swamp model @sntxrr/apprise-notify method run notify apprise \
  --arg title="Hello" --arg body="From swamp"
```

## `when`, in one paragraph

Swamp workflows cannot branch on data — a step's `dependsOn.condition`
understands dependency *state* only (`succeeded`, `failed`, `skipped`,
`always`, and boolean combinations), so "notify only if the previous step
changed something" is inexpressible in YAML. The `when` argument moves that
predicate inside the model, which is the only place it can live:

```yaml
inputs:
  when: ${{ data.latest("home-ip", "homeIp").attributes.changed }}
```

A skip is a normal outcome, not an error.

## Two Apprise behaviours this guards against

**`204 No Content` means nobody was notified.** Apprise returns it when the
config key does not exist — a 2xx that any `res.ok` check reads as success. For
an alerting path that is the worst failure mode there is, because you find out
when an alert you were counting on never arrives. This model raises instead.

**`424` means your tag matched nothing.** Apprise only notifies URLs carrying
the tag you pass; the error names the tag so it is obvious.

Both are measured responses from `apprise-api` v1.4.1, not hypotheticals.

See the [model README](extensions/models/README.md) for the full argument
reference, stateless vs config-key modes, timeouts, and failure handling.

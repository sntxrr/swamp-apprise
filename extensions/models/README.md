# @sntxrr/apprise-notify

Send notifications from swamp through an
[Apprise API](https://github.com/caronc/apprise-api) server.

Apprise fans a single HTTP call out to 100+ services — Matrix, Discord, ntfy,
Slack, email, Pushover — so swamp only has to learn about Apprise instead of
about every notifier behind it. Point this at a self-hosted `apprise-api`
container and every workflow gets notifications.

## Setup

```bash
swamp model create @sntxrr/apprise-notify apprise
```

```yaml
globalArguments:
  apiUrl: "http://apprise:8000"
  configKey: homelab # a stored config on the Apprise server
  defaultTags: homelab
```

```bash
swamp model @sntxrr/apprise-notify method run notify apprise \
  --arg title="Hello" --arg body="From swamp"
```

## Arguments

| Argument | Default                                | Notes                                               |
| -------- | -------------------------------------- | --------------------------------------------------- |
| `title`  | —                                      | Required                                            |
| `body`   | —                                      | Required; honours `format`                          |
| `type`   | `info`                                 | `info` / `success` / `warning` / `failure`          |
| `tags`   | `tagsByType[type]`, then `defaultTags` | Comma-separated; selects which configured URLs fire |
| `format` | `text`                                 | `text` / `markdown` / `html`                        |
| `when`   | `true`                                 | Send only when true — see below                     |

## Routing by type: `tagsByType`

Apprise routes on tags, not on `type`, so failures and successes sent with the
same tags land in the same place. `tagsByType` maps each type to its own tags on
the model, so every step routes correctly without passing `tags`:

```yaml
globalArguments:
  apiUrl: "http://apprise:8000"
  configKey: homelab
  defaultTags: homelab
  tagsByType:
    failure: homelab,alert
    warning: homelab,alert
    success: homelab,done
    info: homelab,done
```

Precedence is the step's `tags`, then `tagsByType[type]`, then `defaultTags`. A
type left out of the mapping falls back to `defaultTags`.

## `when`, and why it exists

Swamp workflows cannot branch on data. A step's `dependsOn.condition`
understands dependency _state_ only — `succeeded`, `failed`, `skipped`,
`always`, and boolean combinations — so there is no way to write "notify only if
the previous step changed something".

`when` moves that predicate inside the model, which is the only place it can
live. A skip is a normal outcome, not an error: it writes a `notification`
resource with `skipped: true` and makes no HTTP call.

```yaml
- name: notify-on-change
  task:
    type: model_method
    modelIdOrName: apprise
    methodName: notify
    inputs:
      when: ${{ data.latest("home-ip", "homeIp").attributes.changed }}
      title: "Home IP changed"
      body: ${{ data.latest("home-ip", "homeIp").attributes.ip }}
  dependsOn:
    - step: sync-home-ip
      condition:
        type: succeeded
```

## Two Apprise behaviours this guards against

**`204 No Content` means nobody was notified.** Apprise returns it when the
config key does not exist. A typo in `configKey` is otherwise indistinguishable
from success — the worst failure mode an alerting path can have, because you
discover it when an alert you were counting on never arrives. This model raises
an error on 204 instead of reporting delivery.

**`424` means your tag matched nothing.** Apprise only notifies URLs carrying
the tag you pass. A tag no configured URL has sends to zero targets; the error
names the tag so it is obvious.

Both are real responses from `apprise-api` v1.4.1, not hypotheticals.

## Modes

Either a stored config or a stateless call — set exactly one:

- **`configKey`** → `POST /notify/<key>`, using URLs stored on the server.
- **`urls`** → `POST /notify` with the Apprise URLs inline. Handy for one-offs,
  but the URLs carry credentials, so prefer `vault.get()` over a literal.

Setting neither is rejected at run time rather than silently defaulting.

## Failure handling

`notify` throws on any non-delivery. If a notification should never fail a
workflow — usually the right call for deploys — set `allowFailure: true` on the
step rather than having the model swallow errors, so the failure is still
visible in the run.

## Timeouts

Apprise contacts third-party services synchronously, so a dead target can hang
the request. `timeoutMs` (default 10000) bounds it; a notification must never be
what stalls a workflow.

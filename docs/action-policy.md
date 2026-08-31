# Action policy

AgentTab separates three controls that solve different problems:

- **Action policy** decides whether a recognizable effect runs immediately or stages a Commit.
- **Pause agents** is a persistent logical admission barrier. It does not add or remove Chrome permissions.
- **Your Turn** remains mandatory for passwords, passkeys, one-time codes, CAPTCHA, payment-card secrets, and other sensitive fields in every policy profile.

## Profiles

| Profile | Recognized send, purchase, delete, permission, upload, or dialog effect | Owned-tab close | Intended use |
|---|---|---|---|
| `autopilot` | Runs immediately | Runs immediately | Fresh-install default for unattended local operation. No semantic Commit prompt is inserted. |
| `review_selected` | Stages Commit | Runs immediately | Review recognizable external effects without interrupting routine tab cleanup. |
| `strict` | Stages Commit | Stages Commit | Preserve the former supervised behavior. |

Autopilot deliberately permits recognized high-cost and irreversible actions. It is not a low-risk mode. It exists for users who trust the local agent and value unattended completion over review prompts. The semantic classifier is best effort in every profile: a webpage can disguise an effect behind an innocent label or attach an unexpected handler to a control.

Changing profiles affects future actions only. A stage already created under a review profile remains staged until it is approved, declined, expires, or is abandoned.

Fresh extension state starts in Autopilot. Any existing persisted extension state that lacks either action-policy field, including imported legacy task or preference state, migrates to Strict with no remembered allowances. This preserves the Commit behavior that installation had before selectable profiles existed.

The action profile and remembered decisions live only in extension storage. They are not added to the native v1 hello, events, host status, or Rust protocol, so the extension policy can deploy without a lockstep host update.

## Remembered approvals

When a Commit is shown in the extension popup, approval can be remembered for:

- the same effect category in the current task;
- the same effect category on the current HTTP or HTTPS origin; or
- the same effect category on all sites.

These are persistent allow decisions. They never bypass sensitive-field handoff, ownership checks, expected page revision, origin policy, or protocol validation. Task-scoped decisions are deleted when the task is finished. The popup shows the number of remembered decisions and can clear all of them in one action.

## Chrome permissions

`debugger` and `scripting` are required install-time permissions. AgentTab does not request or revoke `scripting` as a routine runtime toggle. Pause and Resume change only persisted scheduler admission. Disabling the extension from `chrome://extensions` remains the browser-level off switch.

## Upload roots

The host still requires every upload source to be inside an explicitly configured directory. Add a directory once:

```text
agenttab policy allow-upload PATH
```

The command canonicalizes an existing current-user directory, serializes same-state-directory updates across processes, updates `policy.json` idempotently, and reports whether it added a new root. Restart the AgentTab host when it reports `restartRequired: true`; a repeated no-op reports `false`. `--state-dir PATH` targets a non-default host state directory.

This path grant and the popup action profile are independent. The host rejects a file outside the configured roots before the extension can apply Autopilot.

## Developer mode

The raw `browser_developer` surface retains its adapter discovery flag, managed host policy, and visible extension toggle. Those gates are intentionally separate from Standard action policy because raw DevTools Protocol access is a broader API boundary, not another recognizable webpage effect.

# claude-mods

Claude Code mods for every project.

## next-steps

After every prompt, Claude ends its reply with suggested next steps, grouped by category, and adds them to a to-do list for the project.

- `/todo` opens a clickable panel (terminal, desktop app, VS Code): tick, remove and add steps, switch tracking, show or clear finished ones.
- `/todo on` / `/todo off` switch tracking; `#notodo` or `#todo` in a prompt skips or forces one prompt.
- `/todo list`, `all`, `add <Category>: <text>`, `done <id>`, `undo <id>`, `clear [all]`.
- **A board in the Claude app:** put `.claude/next-steps.json` in a project, `{ "board": "<claude.ai artifact url>" }`, naming a board page whose database collection `items` holds the list. Then that project's list lives on the board, shared by every session, and `/todo` links to it.

Without a board the list is kept per project on the machine running the session.

## Install

On your computer, for every project (this repo is private, so the machine needs GitHub access to it: `gh auth login` or an SSH key):

```
claude plugin marketplace add josh99smith/claude-mods
claude plugin install next-steps@claude-mods --scope user
```

or inside Claude Code: `/plugin install next-steps --marketplace josh99smith/claude-mods`, then pick user scope.

For one project's sessions (cloud ones too), add to its `.claude/settings.json`:

```json
"extraKnownMarketplaces": { "claude-mods": { "source": { "source": "github", "repo": "josh99smith/claude-mods" } } },
"enabledPlugins": { "next-steps@claude-mods": true }
```

A cloud session can fetch this private repo only if the session has access to it.

## Develop

`claude plugin test plugins/next-steps` runs its tests; `claude plugin validate .` checks the marketplace and manifests.

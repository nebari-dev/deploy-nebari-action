# Copilot Instructions

The guidance for contributors and AI agents in this repository lives in [AGENTS.md](../AGENTS.md) at the repository root. Read it before making or reviewing changes.

When reviewing pull requests:

- Do not review changes to `dist/`. It is generated from `src/` by `npm run bundle`, and CI checks that it is up to date.
- Do not review the README input/output tables between the `action-docs` markers. They are generated from `action.yml`.
- If a change modifies the action's functionality or usage, check that `README.md` documents it.
- Check that new inputs are validated before `nic deploy` runs, and that anything the post step needs is saved with `core.saveState` before `nic deploy`.
- Check that credentials and tokens are passed to `core.setSecret` before anything that could log them.

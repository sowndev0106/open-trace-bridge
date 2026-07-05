## Project Rules

- Write everything in English: source code, comments, user-facing strings, tests, documentation, README files, generated prompts, and future notes.
- Keep secrets out of commits. Never commit `.env`, tokens, API keys, SSH keys, database files, cloned workspaces, or OpenCode auth data.
- Preserve the two-port boundary: the public app handles event ingestion, while the admin app and `/internal` API stay private.

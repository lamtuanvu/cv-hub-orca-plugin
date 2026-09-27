# CV Hub for Orca — public repository rules

This repository is public. Everything committed here, including commit messages, tests,
fixtures, docs and screenshots, is published.

## Scope: Orca and CV Hub only

- Write only about Orca, CV Hub and this plugin. Never mention other projects, products,
  companies, customers, teams, people or internal tools, not even as examples.
- Test fixtures and examples use neutral placeholders: `acme/widgets`, `acme/demo`,
  `hub.example.com`, `example.com`. Never copy a real repository, organization or user name
  into a test.
- No local context: no absolute paths from a developer machine (home directories, temp or
  scratch folders, other worktrees), no hostnames or IPs other than CV Hub's public domains,
  loopback, and `example.*`.
- No credentials of any kind: tokens, device codes, client secrets, keys, `.env` files, or
  screenshots and logs that show them.
- No agent working notes: handover prompts, task logs or agent instructions do not belong in
  `docs/`.
- Before committing, review the staged diff against these rules. When unsure whether
  something is internal, leave it out and ask.

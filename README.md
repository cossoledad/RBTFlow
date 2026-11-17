# RBTFlow

Review Board in VS Code, using native sidebar views, diffs, inputs and comments.

- **Submit** — preview branch changes and create a draft. Reviewers, bugs and settings are remembered per repository.
- **Review** — open requests by ID, edit your drafts, publish, read discussions and review code with Ship It.
- **Changes** — browse files as a tree or list, open read-only diffs and jump to inline comments.
- **Inbox** — see assigned reviews, persistent read state and notifications, including feedback on your requests.

Repository Settings offers three diff modes: **Final diff + HEAD** (default, including merge branches), **Squash diff**, and **Commit history** (linear branches).
The default binds the real HEAD commit ID for CI without rewriting Git history. Existing commit owners are detected before upload; conflicted drafts can be kept while opening the existing request.

Comments and the current request refresh automatically, including an open View All Comments document.
New diffs require **Open latest**; local input and existing code snapshots are preserved.
Polling runs while the workspace is open (60 seconds by default); the first sync is silent.
Settings controls polling. Details go to **Output → RBTFlow**.

Install [ganjinbo.rbtflow](https://marketplace.visualstudio.com/items?itemName=ganjinbo.rbtflow), then open a trusted Git workspace with Git, RBTools 7+ and access to Review Board.
Existing `.reviewboardrc` / `rbt login` configuration is reused; server and token settings are available through Repository Settings.
WSL/SSH workspaces need Git and RBTools on the workspace machine. Views can be moved to the bottom panel.

Replies, issue actions, attachments and request lifecycle actions still require the browser. See the [coverage and roadmap](docs/web-parity.md).

## Development

```bash
bash dev.sh start        # Minimal local Review Board; no Docker
bash dev.sh prepare      # Install locked dependencies and compile
bash dev.sh package      # build/rbtflow-0.6.1.vsix
```

The local lab is at http://127.0.0.1:8080/ with disposable accounts `admin` / `reviewer`, password `rbtflow-local`.
It is only for development; extension users connect to their existing server.

[Development and verification](docs/extension.md) · [Local lab](docs/local-lab.md) · [Diff modes and binding](docs/final-diff.md) · [Publishing](docs/publishing.md)

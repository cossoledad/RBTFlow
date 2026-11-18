# Changelog

## 0.6.2

- Discard a request or its unpublished changes from Review, with confirmation.
- Clear Review and Changes locally, then reopen an existing draft from Submit.

- Default to Minimal mode with manual review actions. Full mode enables Inbox and automatic refresh.
- Publish a chosen number of Ship It reviews from the signed-in account.
- Preserve the full selected target branch in every diff mode.
- Compare complete file patches independently of their order and keep mismatched drafts available for inspection.
- Bound the private-draft lookup and back off after API rate limits.

## 0.6.1

- Check public commit owners and your private drafts before uploading a bound HEAD; avoid creating duplicate requests.
- Classify API 227 as a commit conflict, including old recovery records, and stop offering an impossible binding retry.
- Open the existing request or keep the failed draft and continue; archive recovery locally without server writes.

## 0.6.0 (local build)

- Allow publishing after a read-only browser visit by comparing meaningful request content instead of server caches.
- Restore repository-scoped Final diff + HEAD, Squash diff and Commit history settings.
- Refresh the selected request, native inline comments and open discussion transcript on polling or window focus.
- Notify about public reviews/replies and feedback on authored pending requests; retain read state and deduplication.
- Preserve open input and immutable code snapshots; require opening a new diff and resolve external draft conflicts before writing.

## 0.5.0 (local build)

- Unify new Git requests around the frozen final diff and a full, native HEAD commit ID; explicitly disable server diff regeneration.
- Verify commit, target, repository, diff identity, patch and files before and after publication, independently of the current checkout.
- Preserve partial-write journals and request IDs; explicitly complete an uploaded draft without repeating post.
- Retain legacy History browsing/review/publication and compatible linear updates; migrate cached submission preferences.
- Remove the changed-file count badge; retain Inbox unread notifications.
- Click line comments to focus the correct original/changed pane and expand grouped public replies, author/time and issue state.
- Preserve local feedback during same-version navigation; historical discussion is read-only.

## 0.4.0

- Native Inbox for pending requests assigned directly or through review groups, with unread badges and dimmed read items.
- Persistent read state per server/account, mark read/unread controls, and silent startup synchronization.
- Configurable polling and deduplicated native notifications for new requests and published content updates.
- Read all published review bodies, inline/general/attachment/screenshot comments and replies in native collapsible rows or a read-only transcript.
- Jump from line comments to the exact historical diff and source line; display issue status and Ship It.
- A simple branch and check icon for the Marketplace listing.

## 0.3.0

- Native Submit, Review and Changes views, with Quick Pick, Input Box, native editors and checkboxes.
- Git commit messages supply the default request title and description through RBTools.
- Created drafts move into Review for metadata editing, publication and browser access.
- Reviewer selection and publication checks prevent missing-reviewer requests from being left in an uncertain state.
- Tree and list layouts, immutable file comparisons and read-only raw patches.
- Repository defaults, server-backed comparisons, inline comments, review drafts and Ship It.
- Detailed diagnostics in the RBTFlow output channel.
- Marketplace publisher identity: `ganjinbo.rbtflow`. Earlier local builds used `cossoledad.rbtflow`.

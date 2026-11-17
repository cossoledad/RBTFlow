# Final diff and Git HEAD binding

Implementation of the repository requirements in `docs/analysis.md`. This changes the submission contract; it does not run CI, merge, rebase, fetch or push.

## Submission contract

Repository Settings offers three explicit modes, remembered per repository:

| Mode | Upload | Native HEAD binding |
| --- | --- | --- |
| Final diff + HEAD (default) | `--squash-history BASE HEAD`, including merge branches | Required |
| Squash diff | `--squash-history BASE HEAD` | Not forced |
| Commit history | `--with-history BASE HEAD`, linear/non-empty commits only, server capability required | RBTools history semantics |

The binding contract below applies to Final diff + HEAD. Existing bound requests cannot be downgraded to plain Squash; existing History requests retain History. Changing a final-diff request to History requires a new request.
The range remains `merge-base(target, HEAD) → HEAD`, or an explicitly selected ancestral BASE. A target ahead of BASE produces a diagnostic, not a requirement to rewrite the branch.

These values have separate roles:

| Value | Meaning |
| --- | --- |
| BASE / HEAD trees | The frozen file difference to review |
| Full HEAD SHA | The real commit associated with the request for CI |
| Selected target ref | The exact selected value, e.g. `origin/main`, saved in `Draft.branch` |
| Main patch hash | Verification that the uploaded patch matches the preview |

After uploading, the bridge explicitly calls `draft.update(commit_id=HEAD, update_from_commit_id=False, ...)`.
It never asks the server to regenerate the diff from that commit. Native `commit_id` is not set through an RBTools custom field.
Preview and server Commit rows expose the full SHA in a tooltip and copy action.

## Publication and artifact identity

Each new bound final diff stores a versioned `rbtflow_binding_v1` record on the **diff resource**: plan ID, real HEAD, repository ID, target ref, diff ID/revision, patch hash and file-set hash.
This is client metadata, not a signed server approval. Arbitrary draft extra data is not a reliable publication record because unregistered fields are not propagated to the request.
The diff's own extra data survives publication and lets another checkout validate the same artifact.

The bridge writes that metadata before binding the native commit field. Both are required before a draft is accepted as successful.
The draft is marked as requiring binding during `rbt post`, including when the later binding RPC fails. Review Board can deserialize this marker as a number or string; both are recognized.
The bridge accepts only explicit fields, complete SHA-1/SHA-256 IDs and the binding schema. Caller-supplied `public` or `update_from_commit_id` is rejected.

Before publishing a managed request, `RequestSession` checks author/status, fresh request/draft fingerprint, latest diff identity, complete HEAD, target ref, repository, patch hash and files.
It repeats artifact/commit checks on the public result. It does not read the current Git HEAD: switching branches after creating a draft remains supported.
An external, unbound diff update cannot silently reuse a prior bound version's commit ID.

## Partial writes and compatibility

The journal retains the request ID, frozen plan/fields and a draft checkpoint. Binding failure never triggers another post or a publish.
`Check server` reconciles already completed writes, including a lost binding response. Once found, an unknown request ID is persisted before further checks.
`Complete draft` explicitly finishes the original uploaded artifact; it checks the saved checkpoint, author, repository, file set and patch, then binds fields/HEAD without uploading again.
External draft edits block this action. Unsupported server fields or SHA conflicts retain the draft and journal for inspection; clearing a journal does not delete a server request.

Legacy journals keep their original mode and verification contract. Version 0.5 unified-mode preferences migrate to the default bound mode; earlier explicit History/Squash preferences are preserved. Journals and request navigation are unchanged.
Legacy History requests remain readable, reviewable and publishable. Compatible linear updates retain History; nonlinear/empty-commit updates give a short instruction to create a new final-diff request.
Unmanaged older requests without a binding remain publishable under the existing metadata/diff checks.

## Commit conflicts and recovery (0.6.1)

A repository can already associate a HEAD with another request or draft. Before preview/create/update in the bound mode, RBTFlow checks accessible request commit IDs and the current author's private draft commit IDs. The request being explicitly updated is excluded; another user's private draft is never probed. An unavailable preflight fails before upload.

If ownership is known, Review offers **Open existing #ID** and prevents duplicate creation. A race that returns API 227 after upload persists a separate commit-conflict state with the original draft ID/checkpoint. Older partial-upload journals are classified by read-only inspection on startup or Check server. Check server and Complete draft cannot repeat a binding write while a conflict remains.

**Open existing #ID** archives a blocked submission locally, retains its server draft, and opens the chosen request. It does not upload or publish into that request. **Keep draft and continue** archives/releases the local block and returns to the normal workflow. Archives remain in repository state as submissionArchives, including the original plan, fields, request ID and checkpoint. The existing generic Clear recovery command still requires its original explicit confirmation.

If the server reports a conflict whose owner is invisible, no private ID is guessed or disclosed. The exact server/account/repository/HEAD remains blocked even after local release; a new HEAD or another explicit mode can proceed. An existing request that owns that HEAD can still be explicitly updated. A server-completed binding can be reconciled without repeating it. The client does not rewrite commits, remove commit IDs, delete drafts or automatically retarget publication.

## Comment display and navigation

Line comments use exact request/revision/filediff identity and server virtual rows, with a shared mapping for native threads and navigation.
Deleted lines select the original pane; known original-side comments retain that side. Missing row endpoints are not guessed.
Clicking a line comment opens its diff and expands its native thread; a context action still opens the read-only full text.
Public replies are grouped into the parent line thread, with author/time and issue state. Interdiff and custom-base History comments remain readable but are not mapped onto a normal diff.
Navigation within the already selected revision keeps the comparison and local feedback. Historical versions expose read-only discussion; adding feedback/Ship It requires the latest published version.
Late thread loads cannot overwrite a newer comparison/load. Failed line-map loads can retry.

The Changed Files badge is removed. The Inbox unread badge remains separate.

## Validation and boundaries

- `npm test`: Git/range/cache tests plus binding validation, publication preconditions, migration and original/changed row mapping.
- `PYTHONPATH=python build/venv/bin/python -m unittest python/test_bridge.py`: explicit regeneration=false, checkpoint rejection and update-field allowlist.
- `npm run test:integration`: real Review Board uploads/tree reconstruction across five Git shapes, HEAD changes, partial binding recovery, response loss, SHA conflicts/mismatches and legacy History review/publication.
- `npm run test:host`: actual native controls, immutable documents, full SHA, no changed-file badge, deleted-line focus, grouped replies, historical read-only review and the existing Inbox flow.

The previous 0.5 baseline evidence is written under `build/test-v5-*.log`, `build/host/latest.json` and `build/package-validation-v5.json`.
The local run passed 20 TypeScript core checks, 3 Python bridge checks, 10 integration groups and 23 native Extension Host checks.
Integration evidence combines the final binding suite with the Git-shape and existing request/review/discussion runs; the initial partial-binding test failure was corrected and revalidated.
Tests create and modify only synthetic fixture repositories; production adapters use read-only Git commands and do not create clones/worktrees or commits.

Local acceptance targets RBTools 7.0 / Review Board 7.0.6. The company CI experiment in the supplied analysis establishes its observed review association, not an end-to-end CI or merge result for this implementation.
Company compatibility, final merge and push are not validated here. Timestamp/fingerprint checks narrow concurrent-edit windows but are not a server-atomic CAS across separate API calls.

References: [native draft commit update](https://www.reviewboard.org/docs/manual/latest/webapi/2.0/resources/review-request-draft/), [diff metadata updates](https://www.reviewboard.org/docs/manual/latest/webapi/2.0/resources/diff/).

## Read-only browser visits and refresh

Request snapshots compare editable content and artifact identities, not the lazily computed `calculated_trophies` cache or approval/issue counters. Unknown extra data, timestamps, author/repository links and actual editable fields remain protected. Pending journals from older builds are compared by recomputing both snapshots. Public activity/counters have a separate refresh token. See [refresh behavior](extension.md#自动刷新与外部编辑) and [web parity roadmap](web-parity.md).

"""RBTools extension commands, loaded into rbt's own Python environment."""
import hashlib
import json
import re
import base64

from rbtools.commands.base import BaseCommand, CommandError, Option


def repository_defaults(config):
    return {key: config.get(setting)
            for key, setting in (("server", "REVIEWBOARD_URL"), ("targetRef", "TRACKING_BRANCH"),
                                 ("repository", "REPOSITORY"), ("people", "TARGET_PEOPLE"),
                                 ("groups", "TARGET_GROUPS"), ("branch", "BRANCH"))
            if isinstance(config.get(setting), (str, list))}


class Defaults(BaseCommand):
    name = "rbtflow-defaults"

    def main(self):
        self.json.add("defaults", repository_defaults(self.config))


class GuessMessage(BaseCommand):
    name = "rbtflow-guess-message"
    option_list = [Option("--message-file", dest="message_file")]

    def main(self):
        from rbtools.utils.commit_messages import parse_commit_message
        with open(self.options.message_file, encoding="utf-8") as stream:
            fields = parse_commit_message(stream.read().strip(), custom_parser=self.config.get("COMMIT_MESSAGE_PARSER"))
        self.json.add("fields", fields or {})


class PublishRequest(BaseCommand):
    name = "rbtflow-publish-request"
    needs_api = True
    args = "<request-id>"
    option_list = [BaseCommand.server_options]

    def main(self, request_id):
        from rbtools.api.errors import APIError
        try:
            self.api_root.get_review_request(review_request_id=int(request_id)).get_draft().update(public=True)
        except APIError as error:
            self.json.add("error", {"code": error.error_code, "message": str(error)})
            return
        self.json.add("published", True)


class EditRequest(BaseCommand):
    name = "rbtflow-edit-request"
    needs_api = True
    args = "<request-id>"
    option_list = [BaseCommand.server_options, Option("--fields-file", dest="fields_file")]

    def main(self, request_id):
        from rbtools.api.errors import APIError
        with open(self.options.fields_file, encoding="utf-8") as stream:
            data = json.load(stream)
        request = self.api_root.get_review_request(review_request_id=int(request_id))
        try:
            draft = request.get_draft()
        except APIError as error:
            if error.error_code != 100:
                raise
            draft = None
        if request.last_updated != data["request_updated"] or (draft.last_updated if draft else None) != data["draft_updated"]:
            self.json.add("error", {"code": 409, "message": "Request changed; refresh before editing"})
            self.json.add("not_applied", True)
            return
        values = data["fields"]
        allowed = {"summary", "description", "target_people", "target_groups", "bugs_closed"}
        if set(values) - allowed or not all(isinstance(value, str) for value in values.values()):
            raise CommandError("Invalid request fields")
        try:
            if draft is None:
                draft = request.get_or_create_draft()
            draft.update(**values, description_text_type="plain", **{"extra_data.rbtflow_request_operation_id": data["operation_id"]})
        except APIError as error:
            self.json.add("error", {"code": error.error_code, "message": str(error)})


class DiscardRequest(BaseCommand):
    name = "rbtflow-discard-request"
    needs_api = True
    args = "<request-id>"
    option_list = [BaseCommand.server_options, Option("--fields-file", dest="fields_file")]

    def main(self, request_id):
        from rbtools.api.errors import APIError
        with open(self.options.fields_file, encoding="utf-8") as stream:
            data = json.load(stream)
        try:
            session = self.api_root.get_session().rsp["session"]
            if not session.get("authenticated") or session["links"]["user"]["title"] != data["author"]:
                self.json.add("error", {"code": 409, "message": "Sign in as the original author."})
                self.json.add("not_applied", True)
                return
            request = self.api_root.get_review_request(review_request_id=int(request_id))
            author = request.rsp["review_request"]["links"]["submitter"]["title"]
            if author != data["author"]:
                self.json.add("error", {"code": 409, "message": "Only the current author can discard this request."})
                self.json.add("not_applied", True)
                return
            try:
                draft = request.get_draft()
            except APIError as error:
                if error.error_code != 100:
                    raise
                draft = None
            if (request.status != "pending" or request.public != data["public"]
                    or request.last_updated != data["request_updated"]
                    or (draft.last_updated if draft else None) != data["draft_updated"]
                    or (draft.id if draft else None) != data["draft_id"]):
                self.json.add("error", {"code": 409, "message": "Request changed. Refresh before discarding."})
                self.json.add("not_applied", True)
                return
            if request.public and draft is not None:
                draft.delete()
            else:
                request.update(status="discarded")
        except APIError as error:
            self.json.add("error", {"code": error.error_code, "message": str(error)})
            return
        self.json.add("discarded", True)


class Context(BaseCommand):
    name = "rbtflow-context"
    needs_api = True
    option_list = [BaseCommand.server_options]

    def main(self):
        # Preserve the actual configured URL, including aliases/proxy paths,
        # instead of switching to the site's advertised canonical URL.
        self.json.add("server_url", self.server_url)
        self.json.add("defaults", repository_defaults(self.config))


class SyncDraft(BaseCommand):
    name = "rbtflow-sync-draft"
    needs_api = True
    args = "<review-request-id>"
    option_list = [BaseCommand.server_options, Option("--fields-file", dest="fields_file")]

    def main(self, review_request_id):
        from rbtools.api.errors import APIError
        with open(self.options.fields_file, encoding="utf-8") as stream:
            data = json.load(stream)
        allowed = {"summary", "description", "testing_done", "target_people", "target_groups",
                   "bugs_closed", "branch", "changedescription", "description_text_type",
                   "testing_done_text_type", "changedescription_text_type", "extra_data.rbtflow_plan_id",
                   "commit_id", "extra_data.rbtflow_binding_version", "_binding", "_request_updated", "_draft_updated"}
        if set(data) - allowed or not all(isinstance(value, str) for value in data.values()):
            raise CommandError("Invalid RBTFlow draft fields")
        binding = json.loads(data.pop('_binding')) if '_binding' in data else None
        request_updated = data.pop('_request_updated', None)
        draft_updated = data.pop('_draft_updated', None)
        commit_id = data.get('commit_id')
        if commit_id is not None and not re.fullmatch(r'(?:[a-f0-9]{40}|[a-f0-9]{64})', commit_id):
            raise CommandError('A full Git HEAD SHA is required')
        if binding is not None:
            required = {'version', 'planId', 'head', 'repositoryId', 'targetBranch', 'diffId', 'revision', 'patchHash', 'filesHash'}
            if (not isinstance(binding, dict) or not required <= set(binding) or set(binding) - required - {'patchFormat'}
                    or ('patchFormat' in binding and binding['patchFormat'] != 'git-blocks-v1')
                    or binding['version'] != 1 or binding['head'] != commit_id
                    or binding['targetBranch'] != data.get('branch') or binding['planId'] != data.get('extra_data.rbtflow_plan_id')
                    or not all(isinstance(binding[key], int) and binding[key] > 0 for key in ('repositoryId', 'diffId', 'revision'))):
                raise CommandError('Invalid RBTFlow commit binding')
        try:
            review = self.api_root.get_review_request(review_request_id=int(review_request_id))
            draft = review.get_draft()
            if request_updated is not None and (review.last_updated != request_updated or draft.last_updated != draft_updated):
                self.json.add('error', {'code': 409, 'message': 'Draft changed; check the server before continuing'})
                self.json.add('not_applied', True)
                return
            if binding is not None:
                if review.created_with_history:
                    raise CommandError('Cannot convert a history review request')
                diff = self.api_client.get_path(f'/review-requests/{int(review_request_id)}/draft/diffs/{int(binding["revision"])}/')
                if diff.id != binding['diffId']:
                    raise CommandError('Uploaded diff changed')
                # Store the artifact binding on the diff itself: unlike arbitrary
                # draft extra_data, diff metadata survives publication unchanged.
                # Write it before the native commit field so a rejected binding
                # leaves the request checkpoint intact for explicit recovery.
                diff.update(**{'extra_data.rbtflow_binding_v1': json.dumps(binding, separators=(',', ':'))})
            draft.update(**data, update_from_commit_id=False)
        except APIError as error:
            self.json.add('error', {'code': error.error_code, 'message': str(error)})
            return
        self.json.add("review_request_id", review.id)


def git_patch_content_hash(data):
    blocks = re.split(br'\n(?=diff --git )', data)
    headers = {block.partition(b'\n')[0] for block in blocks}
    if not blocks[0].startswith(b'diff --git ') or len(headers) != len(blocks):
        return hashlib.sha256(data.rstrip(b'\n')).hexdigest()
    hashes = sorted(hashlib.sha256(block.rstrip(b'\n')).hexdigest() for block in blocks)
    return hashlib.sha256('\n'.join(hashes).encode('ascii')).hexdigest()


class VerifyPatch(BaseCommand):
    name = "rbtflow-verify-patch"
    needs_api = True
    args = "<review-request-id> <revision> <scope>"
    option_list = [BaseCommand.server_options]

    def main(self, review_request_id, revision, scope):
        if scope not in ("draft", "published"):
            raise CommandError("Invalid diff scope")
        prefix = "draft/" if scope == "draft" else ""
        resource = self.api_client.get_path(
            f"/review-requests/{int(review_request_id)}/{prefix}diffs/{int(revision)}/")
        data = resource.get_patch().data
        if isinstance(data, str):
            data = data.encode("utf-8")
        # rbt diff adds a console newline which is absent in the API patch.
        self.json.add("patch_hash", hashlib.sha256(data.rstrip(b"\n")).hexdigest())
        self.json.add("patch_content_hash", git_patch_content_hash(data))


class FindCommitRequests(BaseCommand):
    """Find public commit owners and our own drafts; never probe others' drafts."""
    name = 'rbtflow-find-commit'
    needs_api = True
    args = '<repository-id> <head> <exclude-id> [draft-budget]'
    option_list = [BaseCommand.server_options]

    def main(self, repository_id, head, exclude_id, draft_budget='12'):
        from rbtools.api.errors import APIError
        repository_id, exclude_id, draft_budget = int(repository_id), int(exclude_id), int(draft_budget)
        if repository_id < 1 or exclude_id < 0 or not 0 <= draft_budget <= 12 or not re.fullmatch(r'(?:[a-f0-9]{40}|[a-f0-9]{64})', head):
            raise CommandError('Invalid commit lookup')
        session = self.api_root.get_session().rsp['session']
        username = session.get('links', {}).get('user', {}).get('title')
        if not session.get('authenticated') or not username:
            raise CommandError('Sign in before checking commit ownership')
        self.json.add('username', username)

        def requests(**query):
            start = 0
            while True:
                page = self.api_client.get_path('/review-requests/', **{
                    'repository': repository_id, 'status': 'all', 'max-results': 200, 'start': start, **query}).rsp
                values = page['review_requests']
                yield from values
                start += len(values)
                if start >= page.get('total_results', start):
                    return
                if not values or start >= 10000:
                    raise CommandError('Commit lookup exceeds the pagination limit')

        found = {}

        def add(review):
            author = review['links'].get('submitter', {}).get('title', '')
            if review['id'] != exclude_id and (review['public'] or author == username):
                found[review['id']] = {'id': review['id'], 'public': review['public'], 'status': review['status'],
                                       'author': author}

        for review in requests(**{'commit-id': head}):
            if review.get('commit_id') == head:
                add(review)
        # The commit-id query filters the public database column, not draft.commit_id.
        if not found and draft_budget:
            # One bounded page, even if the account has thousands of requests.
            recent = self.api_client.get_path('/review-requests/', **{
                'repository': repository_id, 'status': 'all', 'max-results': draft_budget, 'from-user': username,
            }).rsp['review_requests']
            for review in recent[:draft_budget]:
                if review['id'] == exclude_id or review['links'].get('submitter', {}).get('title') != username:
                    continue
                try:
                    draft = self.api_client.get_path(f'/review-requests/{review["id"]}/draft/').rsp['draft']
                except APIError as error:
                    if error.error_code != 100:
                        raise
                    continue
                if draft.get('commit_id') == head:
                    add(review)
        self.json.add('requests', list(found.values()))


class WatchUpdates(BaseCommand):
    """Read activity in one authenticated process, without touching any drafts."""
    name = 'rbtflow-watch'
    needs_api = True
    option_list = [BaseCommand.server_options, Option('--fields-file', dest='fields_file')]

    def main(self):
        from rbtools.api.errors import APIError
        with open(self.options.fields_file, encoding='utf-8') as stream:
            data = json.load(stream)
        ids = data.get('ids', [])
        selected_id = data.get('selected_id')
        if (set(data) - {'ids', 'selected_id'} or not isinstance(ids, list) or len(ids) > 10000
                or any(type(value) is not int or value < 1 for value in ids)
                or (selected_id is not None and (type(selected_id) is not int or selected_id < 1))):
            raise CommandError('Invalid watch targets')
        session = self.api_root.get_session().rsp['session']
        username = session.get('links', {}).get('user', {}).get('title')
        if not session.get('authenticated') or not username:
            raise CommandError('Sign in before refreshing reviews')
        self.json.add('username', username)
        errors = []

        def get(path, key):
            return self.api_client.get_path(path).rsp[key]

        def items(path, key):
            result = []
            while True:
                page = self.api_client.get_path(path, **{'max-results': 200, 'start': len(result)}).rsp
                values = page[key]
                result.extend(values)
                if len(result) >= page.get('total_results', len(result)):
                    return result
                if not values or len(result) >= 10000:
                    raise CommandError('Watch collection exceeds the pagination limit')

        def optional(path, key):
            try:
                return get(path, key)
            except APIError as error:
                if error.error_code != 100:
                    raise
                return None

        def activity(request_id):
            try:
                value = get(f'/review-requests/{request_id}/last-update/', 'last_update')
                user = value.get('user') or {}
                return {'id': request_id, 'type': value['type'], 'timestamp': value['timestamp'],
                        'actor': user if isinstance(user, str) else user.get('username', '')}
            except APIError as error:
                if error.error_code == 114:
                    raise
                errors.append({'id': request_id, 'code': error.error_code, 'message': str(error)})
                return None

        updates = [value for request_id in dict.fromkeys(ids) if (value := activity(request_id)) is not None]
        self.json.add('updates', updates)
        if selected_id is not None:
            prefix = f'/review-requests/{selected_id}/'
            review = get(prefix, 'review_request')
            # Keep the same private-draft boundary as ReviewBrowser, including for administrators.
            own = review.get('links', {}).get('submitter', {}).get('title') == username
            draft = optional(prefix + 'draft/', 'draft') if own else None
            versions = [{**value, 'scope': 'published'} for value in items(prefix + 'diffs/', 'diffs')]
            if draft:
                versions.extend({**value, 'scope': 'draft'} for value in items(prefix + 'draft/diffs/', 'diffs'))
            reviewer_draft = optional(prefix + 'reviews/draft/', 'review') if review['public'] else None
            comments = items(prefix + f'reviews/{reviewer_draft["id"]}/diff-comments/', 'diff_comments') if reviewer_draft else []
            self.json.add('selected', {'review': review, 'draft': draft,
                'versions': [{'scope': value['scope'], 'id': value['id'], 'revision': value['revision']} for value in versions],
                'reviewerDraft': reviewer_draft, 'reviewerComments': comments,
                'activity': activity(selected_id) if review['public'] else None})
        self.json.add('errors', errors)


class ReadComparison(BaseCommand):
    name = "rbtflow-read-comparison"
    needs_api = True
    args = "<request-id> <revision> <scope> <file-id> <part>"
    option_list = [BaseCommand.server_options]

    def main(self, request_id, revision, scope, file_id, part):
        if scope not in ("draft", "published") or part not in ("base", "head", "lines", "patch"):
            raise CommandError("Invalid comparison scope")
        prefix = "draft/" if scope == "draft" else ""
        url = f"/review-requests/{int(request_id)}/{prefix}diffs/{int(revision)}/"
        if part == "patch":
            data = self.api_client.get_path(url).get_patch().data
        else:
            resource = self.api_client.get_path(f"{url}files/{int(file_id)}/")
            if part == "lines":
                result = resource.get_diff_data().rsp["diff_data"]
                self.json.add("rows", [[row[0], row[1], row[4]]
                                      for chunk in result.get("chunks", []) for row in chunk.get("lines", [])])
                return
            data = (resource.get_original_file() if part == "base" else resource.get_patched_file()).data
        if isinstance(data, str):
            data = data.encode("utf-8")
        if len(data) > 16 * 1024 * 1024:
            raise CommandError("File exceeds the 16 MiB comparison limit")
        self.json.add("content", base64.b64encode(data).decode("ascii"))


class SaveReview(BaseCommand):
    name = "rbtflow-save-review"
    needs_api = True
    args = "<request-id>"
    option_list = [BaseCommand.server_options, Option("--fields-file", dest="fields_file")]

    def main(self, request_id):
        from rbtools.api.errors import APIError
        with open(self.options.fields_file, encoding="utf-8") as stream:
            data = json.load(stream)
        request_id = int(request_id)
        request = self.api_root.get_review_request(review_request_id=request_id)
        if not request.public or request.status != "pending":
            raise CommandError("Review request must be public and pending")
        if data["action"] == "publish":
            review = request.get_reviews().get_item(int(data["review_id"]))
            if not review.public:
                if review.timestamp != data["expected_timestamp"]:
                    raise CommandError("Review draft changed; reload before publishing")
                review.update(public=True)
        elif data["action"] == "save":
            try:
                review = self.api_root.get_review_draft(review_request_id=request_id)
            except APIError as error:
                if error.error_code != 100:
                    raise
                review = None
            if review is not None and (review.id != data.get("review_id") or review.timestamp != data.get("expected_timestamp")):
                raise CommandError("Review draft changed; reload before saving")
            if review is None and data.get("review_id"):
                raise CommandError("Review draft no longer exists")
            if review is None:
                review = request.get_reviews().create()
            review.update(body_top=data["body"], body_top_text_type="plain", ship_it=data["ship_it"],
                          **{"extra_data.rbtflow_operation_id": data["operation_id"]})
            existing = list(review.get_diff_comments().all_items)
            for comment in data["comments"]:
                if any(item.extra_data.get("rbtflow_comment_id") == comment["id"] for item in existing):
                    continue
                review.get_diff_comments().create(
                    filediff_id=int(comment["fileId"]), first_line=int(comment["firstLine"]),
                    num_lines=int(comment["numLines"]), text=comment["text"], text_type="plain",
                    issue_opened=bool(comment["issueOpened"]),
                    **{"extra_data.rbtflow_comment_id": comment["id"], "extra_data.rbtflow_side": comment["side"]})
        else:
            raise CommandError("Invalid review action")
        self.json.add("review_id", review.id)

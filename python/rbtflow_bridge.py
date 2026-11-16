"""RBTools extension commands, loaded into rbt's own Python environment."""
import hashlib
import json
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
        with open(self.options.fields_file, encoding="utf-8") as stream:
            data = json.load(stream)
        allowed = {"summary", "description", "testing_done", "target_people", "target_groups",
                   "bugs_closed", "branch", "changedescription", "description_text_type",
                   "testing_done_text_type", "changedescription_text_type", "extra_data.rbtflow_plan_id"}
        if set(data) - allowed or not all(isinstance(value, str) for value in data.values()):
            raise CommandError("Invalid RBTFlow draft fields")
        review = self.api_root.get_review_request(review_request_id=int(review_request_id))
        review.get_draft().update(**data)
        self.json.add("review_request_id", review.id)


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

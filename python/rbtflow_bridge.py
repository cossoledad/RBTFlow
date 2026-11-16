"""RBTools extension commands, loaded into rbt's own Python environment."""
import hashlib
import json

from rbtools.commands.base import BaseCommand, CommandError, Option


class Context(BaseCommand):
    name = "rbtflow-context"
    needs_api = True
    option_list = [BaseCommand.server_options]

    def main(self):
        # Preserve the actual configured URL, including aliases/proxy paths,
        # instead of switching to the site's advertised canonical URL.
        self.json.add("server_url", self.server_url)


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

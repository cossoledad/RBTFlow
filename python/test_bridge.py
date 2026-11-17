"""Focused bridge contract tests; no Review Board service or Git writes."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from rbtools.commands.base import CommandError
from rbtflow_bridge import FindCommitRequests, SyncDraft


class SyncDraftTest(unittest.TestCase):
    def invoke(self, extra=None, stale=False):
        head = 'a' * 40
        binding = {'version': 1, 'planId': 'plan', 'head': head, 'repositoryId': 1, 'targetBranch': 'origin/main',
                   'diffId': 4, 'revision': 1, 'patchHash': 'b' * 64, 'filesHash': 'c' * 64}
        data = {'commit_id': head, 'branch': 'origin/main', 'extra_data.rbtflow_plan_id': 'plan',
                '_binding': json.dumps(binding), '_request_updated': 'r1', '_draft_updated': 'd1'}
        data.update(extra or {})
        command = object.__new__(SyncDraft)
        command.api_root = Mock()
        command.api_client = Mock()
        command.json = Mock()
        review = command.api_root.get_review_request.return_value
        review.created_with_history = False
        review.last_updated = 'changed' if stale else 'r1'
        draft = review.get_draft.return_value
        draft.last_updated = 'd1'
        command.api_client.get_path.return_value.id = 4
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / 'fields.json'
            filename.write_text(json.dumps(data))
            command.options = SimpleNamespace(fields_file=str(filename))
            command.main('2')
        return command, draft

    def test_native_commit_update_explicitly_disables_diff_regeneration(self):
        command, draft = self.invoke()
        self.assertIs(draft.update.call_args.kwargs['update_from_commit_id'], False)
        self.assertEqual(draft.update.call_args.kwargs['commit_id'], 'a' * 40)
        self.assertNotIn('_binding', draft.update.call_args.kwargs)
        command.api_client.get_path.return_value.update.assert_called_once()

    def test_stale_checkpoint_does_not_mutate(self):
        command, draft = self.invoke(stale=True)
        draft.update.assert_not_called()
        command.api_client.get_path.return_value.update.assert_not_called()
        self.assertIn(unittest.mock.call('not_applied', True), command.json.add.call_args_list)

    def test_unapproved_parameters_and_short_sha_are_rejected(self):
        for fields in [{'update_from_commit_id': 'true'}, {'public': 'true'}, {'commit_id': 'abcd'}]:
            with self.subTest(fields=fields), self.assertRaises(CommandError):
                self.invoke(fields)


class CommitOwnersTest(unittest.TestCase):
    def test_public_owners_and_own_drafts_are_paginated_without_probing_other_users(self):
        command = object.__new__(FindCommitRequests)
        command.api_root = Mock()
        command.api_root.get_session.return_value.rsp = {'session': {'authenticated': True, 'links': {'user': {'title': 'alice'}}}}
        command.api_client = Mock()
        command.json = Mock()
        head = 'a' * 40
        public_match = True

        def review(identifier, author, commit=None, public=False, status='pending'):
            return {'id': identifier, 'commit_id': commit, 'public': public, 'status': status,
                    'links': {'submitter': {'title': author}}}

        def get(path, **query):
            if path == '/review-requests/':
                self.assertEqual(query['repository'], 1)
                if 'commit-id' in query:
                    if not public_match:
                        return SimpleNamespace(rsp={'review_requests': [], 'total_results': 0})
                    page = [review(1, 'alice', head, True), review(8, 'bob', head)] if query['start'] == 0 else [review(4, 'bob', head, True, 'submitted')]
                    return SimpleNamespace(rsp={'review_requests': page, 'total_results': 3})
                self.assertEqual(query['from-user'], 'alice')
                return SimpleNamespace(rsp={'review_requests': [review(1, 'alice'), review(2, 'alice'), review(9, 'bob')]})
            self.assertEqual(path, '/review-requests/2/draft/', 'Never probe a foreign private draft')
            return SimpleNamespace(rsp={'draft': {'commit_id': head}})

        command.api_client.get_path.side_effect = get
        command.main('1', head, '1')
        values = {call.args[0]: call.args[1] for call in command.json.add.call_args_list}
        self.assertEqual(values['username'], 'alice')
        self.assertEqual([value['id'] for value in values['requests']], [4])
        public_match = False
        command.main('1', head, '1')
        values = {call.args[0]: call.args[1] for call in command.json.add.call_args_list}
        self.assertEqual([value['id'] for value in values['requests']], [2])

    def test_invalid_repository_head_or_exclusion_never_queries_the_server(self):
        command = object.__new__(FindCommitRequests)
        command.api_root = Mock()
        for args in [('0', 'a' * 40, '0'), ('1', 'abcd', '0'), ('1', 'a' * 40, '-1')]:
            with self.subTest(args=args), self.assertRaises(CommandError):
                command.main(*args)
        command.api_root.get_session.assert_not_called()


if __name__ == '__main__':
    unittest.main()

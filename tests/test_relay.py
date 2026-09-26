"""Exercise the real connector against a paginated, task-scoped GitHub API fixture."""
import base64
import copy
import json
import re
import time
import unittest
import zipfile
from urllib.parse import parse_qs, urlparse

import test_connector as legacy
from test_connector import TaskAPI, sha
from test_probe import PWSH


class RelayAPI(TaskAPI):
    def do_GET(self):
        u = urlparse(self.path)
        self.ctx['gets'].append(u.path)
        page = int(parse_qs(u.query).get('page', ['1'])[0])
        if '/contents/.aiconnector/relay.json' in u.path:
            return self.reply(dict(encoding='base64', content=base64.b64encode(json.dumps(self.ctx['descriptor']).encode()).decode()))
        if u.path == '/repos/test/tasks/issues':
            if self.ctx.get('issue_page_failure') == page:
                return self.reply({}, 503)
            return self.reply(self.ctx['issues'][(page-1)*100:page*100])
        match = re.fullmatch(r'/repos/test/tasks/issues/(\d+)/comments', u.path)
        if match:
            if self.ctx['fail_page'] == page:
                return self.reply({}, 503)
            rows = [c for c in self.ctx['comments'] if c['issue_number'] == int(match[1])]
            return self.reply(rows[(page-1)*100:page*100])
        if '/releases/tags/' in u.path:
            release = self.ctx['releases'].get(u.path.split('/tags/')[1])
            return self.reply(release or {}, 200 if release else 404)
        match = re.fullmatch(r'/repos/test/tasks/releases/(\d+)/assets', u.path)
        if match:
            rows = [a for a in self.ctx['release_assets'] if a['release_id'] == int(match[1])]
            return self.reply(rows[(page-1)*100:page*100])
        if u.path.startswith('/assets/'):
            self.ctx['artifact_auth'].append(self.headers.get('Authorization'))
            data = self.ctx['assets'].get(u.path)
            return self.reply(data if data is not None else {}, 200 if data is not None else 404)
        return self.reply({}, 404)

    def do_POST(self):
        u = urlparse(self.path)
        raw = self.rfile.read(int(self.headers['Content-Length']))
        self.ctx['posts'].append(u.path)
        login = 'mac-user' if 'MAC_TOKEN' in (self.headers.get('Authorization') or '') else 'win-user'
        kind = 'comment'
        if u.path == '/repos/test/tasks/issues': kind = 'issue'
        elif u.path == '/repos/test/tasks/releases': kind = 'release'
        elif u.path.endswith('/assets'): kind = 'asset'
        mode = self.ctx.get('provision_mode', {}).get(kind)
        if mode == 'before':
            time.sleep(1.5)
            return self.reply({}, 503)
        if mode == 'rate': return self.reply({}, 429, {'Retry-After': '2'})
        if mode == 'reject': return self.reply({}, 403)
        data = json.loads(raw) if kind != 'asset' else None
        if kind == 'issue':
            number = len(self.ctx['issues']) + 1
            row = dict(data, number=number, user=dict(login=login), state='open',
                       html_url=f'https://github.com/test/tasks/issues/{number}', created_at='2026-09-26T01:00:00Z')
            self.ctx['issues'].append(row)
        elif kind == 'release':
            if data['tag_name'] in self.ctx['releases']: return self.reply({}, 422)
            number = len(self.ctx['releases']) + 7
            row = dict(data, id=number, author=dict(login=login),
                       upload_url=self.ctx['base']+f'/repos/test/tasks/releases/{number}/assets{{?name,label}}')
            self.ctx['releases'][data['tag_name']] = row
        elif kind == 'asset':
            number = int(u.path.split('/')[-2])
            release = next(r for r in self.ctx['releases'].values() if r['id'] == number)
            name = parse_qs(u.query)['name'][0]
            path = '/assets/'+release['tag_name']+'/'+name
            self.ctx['assets'][path] = raw
            row = dict(id=len(self.ctx['release_assets'])+1, name=name, size=len(raw),
                       release_id=number, state='uploaded', browser_download_url=self.ctx['base']+path)
            self.ctx['release_assets'].append(row)
        else:
            number = int(u.path.split('/')[-2])
            comment_id = len(self.ctx['comments'])+1
            row = dict(id=comment_id, issue_number=number, body=data['body'], user=dict(login=login),
                       html_url=f'https://github.com/test/tasks/issues/{number}#issuecomment-{comment_id}',
                       created_at=f'2026-09-26T02:00:{comment_id:02d}Z', updated_at=f'2026-09-26T02:00:{comment_id:02d}Z')
            self.ctx['comments'].append(row)
        if mode == 'after': time.sleep(1.5)
        return self.reply(row, 201)


@unittest.skipUnless(PWSH, 'requires PowerShell')
class RelayTests(unittest.TestCase):
    tearDown = legacy.ConnectorTests.tearDown
    write_config = legacy.ConnectorTests.write_config
    write_inputs = legacy.ConnectorTests.write_inputs
    command = legacy.ConnectorTests.command
    run_cli = legacy.ConnectorTests.run_cli
    read_state = legacy.ConnectorTests.read_state
    submit = legacy.ConnectorTests.submit
    poll = legacy.ConnectorTests.poll
    ready = legacy.ConnectorTests.ready
    complete_flow = legacy.ConnectorTests.complete_flow

    def setUp(self):
        legacy.ConnectorTests.setUp(self)
        self.server.RequestHandlerClass = RelayAPI
        self.config.update(schema='aiconnector.config.v2', layout='task-issues-run-releases-v1')
        self.config.pop('issue'); self.config.pop('release_tag'); self.write_config()
        self.ctx.update(issues=[], releases={}, provision_mode={}, descriptor=dict(
            schema='aiconnector.relay.v1', repository='test/tasks', namespace=self.config['namespace'],
            layout=self.config['layout'], protocol='aiconnector.task.v1', max_artifact_bytes=5242879))

    def zip_path(self):
        path = self.folder/'input.zip'
        with zipfile.ZipFile(path, 'w') as z: z.writestr('sample.txt', 'synthetic only')
        return path

    def clear_cooldown(self, node):
        state = self.read_state(node); state['next_poll'] = 0; state['post_not_before'] = 0
        raw = json.dumps(state, separators=(',', ':')).encode()
        (self.folder/node/'state.json').write_text(json.dumps(dict(
            schema='aiconnector.store.v1', sha256=sha(raw), data_base64=base64.b64encode(raw).decode())))

    def test_handoff_creates_one_issue_one_release_and_persists_timeline(self):
        self.complete_flow()
        self.assertEqual(len(self.ctx['issues']), 1)
        self.assertEqual(len(self.ctx['releases']), 1)
        self.assertEqual(len(self.ctx['comments']), 5)
        issue = self.ctx['issues'][0]
        self.assertEqual(issue['title'], '[AIC][smoke] '+self.task['title'])
        self.assertEqual(issue['labels'], ['aiconnector:task', 'aiconnector:protocol-v1'])
        release = next(iter(self.ctx['releases'].values()))
        self.assertEqual(release['tag_name'], 'aic-v1.experiments-v1.smoke.r1.run-001')
        self.assertFalse(release['draft']); self.assertTrue(release['prerelease'])
        status = self.poll('mac-outer')['runs'][0]
        self.assertEqual(status['phase'], 'receipt')
        self.assertEqual(status['issue_url'], issue['html_url'])
        self.assertEqual([x['kind'] for x in status['timeline']], ['task','accepted','started','result','receipt'])
        self.assertTrue(all(x['published_at'] and x['observed_at'] and x['url'] for x in status['timeline']))
        self.assertEqual(status['timeline'][0]['published_at'], '2026-09-26T02:00:01.000Z')
        self.assertEqual(status['timeline'][1]['author'], 'win-user')
        self.poll('windows-inner'); self.poll('mac-outer')
        self.assertEqual(len(self.ctx['posts']), 7)

    def test_revisions_and_runs_share_issue_but_get_distinct_releases(self):
        self.submit(); self.poll('mac-outer')
        self.task['run_id'] = 'run-002'; self.write_inputs(); self.submit(); self.poll('mac-outer')
        self.task['revision'] = 2; self.task['objective'] = 'new revision'; self.write_inputs(); self.submit(); self.poll('mac-outer')
        self.assertEqual(len(self.ctx['issues']), 1)
        self.assertEqual(len(self.ctx['releases']), 3)
        self.assertEqual(len(self.poll('windows-inner')['runs']), 3)

    def test_different_tasks_route_to_different_issues(self):
        self.submit(); self.poll('mac-outer')
        self.task['task_id'] = 'second'; self.write_inputs(); self.submit(); self.poll('mac-outer')
        self.assertEqual(len(self.ctx['issues']), 2)
        self.assertEqual([c['issue_number'] for c in self.ctx['comments']], [1, 2])
        self.assertEqual(len(self.poll('windows-inner')['runs']), 2)

    def test_wrong_issue_event_and_untrusted_issue_are_ignored(self):
        self.submit(); self.poll('mac-outer')
        wrong = copy.deepcopy(self.ctx['issues'][0]); wrong['number'] = 2
        wrong['body'] = wrong['body'].replace('"task_id":"smoke"', '"task_id":"other"')
        self.ctx['issues'].append(wrong)
        self.ctx['comments'][0]['issue_number'] = 2
        self.assertEqual(self.poll('windows-inner')['runs'], [])
        self.assertEqual(len(self.ctx['comments']), 1)
        self.ctx['issues'][0]['user']['login'] = 'outsider'
        self.assertEqual(self.run_cli('windows-inner','Poll',ok=False)['code'], 'TASK_ISSUE_MISSING_OR_CHANGED')

    def test_modified_or_duplicate_issue_stops_before_acceptance(self):
        self.submit(); self.poll('mac-outer')
        clone = copy.deepcopy(self.ctx['issues'][0]); clone['number'] = 2
        self.ctx['issues'].append(clone)
        self.assertEqual(self.run_cli('windows-inner','Poll',ok=False)['code'], 'DUPLICATE_TASK_ISSUE')
        self.assertEqual(self.read_state('windows-inner')['events'], {})
        self.ctx['issues'].pop(); self.clear_cooldown('windows-inner'); self.poll('windows-inner')
        self.ctx['issues'][0]['body'] = self.ctx['issues'][0]['body'].replace('初始目标', '改写目标')
        self.assertEqual(self.run_cli('windows-inner','Poll',ok=False)['code'], 'TASK_ISSUE_CHANGED')

    def test_issue_closed_and_title_changed_do_not_cancel_or_rerun(self):
        self.complete_flow()
        self.ctx['issues'][0].update(state='closed', title='人工归档')
        self.assertEqual(self.poll('windows-inner')['runs'][0]['phase'], 'receipt')
        self.assertFalse(self.run_cli('windows-inner','Claim','-Key',self.key)['execute'])
        self.assertEqual(len(self.ctx['posts']), 7)

    def test_wrong_repository_manifest_prevents_any_write(self):
        self.ctx['descriptor']['repository'] = 'wrong/repo'
        self.submit()
        self.assertEqual(self.run_cli('mac-outer','Poll',ok=False)['code'], 'RELAY_MANIFEST_MISMATCH')
        self.assertEqual(self.ctx['posts'], [])

    def test_uncertain_issue_creation_recovers_without_duplicate(self):
        self.submit(); self.ctx['provision_mode']['issue'] = 'after'
        self.poll('mac-outer')
        self.ctx['provision_mode'].clear(); self.poll('mac-outer')
        self.assertEqual(len(self.ctx['issues']), 1)
        self.assertEqual(len(self.ctx['comments']), 1)
        self.assertEqual(self.ctx['posts'].count('/repos/test/tasks/issues'), 1)

    def test_unknown_issue_creation_not_found_is_never_reposted(self):
        self.submit(); self.ctx['provision_mode']['issue'] = 'before'
        self.poll('mac-outer'); self.ctx['provision_mode'].clear()
        self.assertEqual(self.run_cli('mac-outer','Poll',ok=False)['code'], 'PROVISION_UNCERTAIN_OR_REJECTED')
        self.assertEqual(self.ctx['posts'].count('/repos/test/tasks/issues'), 1)

    def test_release_creation_timeout_and_unknown_do_not_duplicate(self):
        self.submit(); self.ctx['provision_mode']['release'] = 'after'
        self.poll('mac-outer'); self.ctx['provision_mode'].clear(); self.poll('mac-outer')
        self.assertEqual(self.ctx['posts'].count('/repos/test/tasks/releases'), 1)
        self.assertEqual(len(self.ctx['comments']), 1)
        self.task['run_id'] = 'run-002'; self.write_inputs(); self.submit()
        self.ctx['provision_mode']['release'] = 'before'; self.poll('mac-outer')
        self.ctx['provision_mode'].clear()
        self.assertEqual(self.run_cli('mac-outer','Poll',ok=False)['code'], 'PROVISION_UNCERTAIN_OR_REJECTED')
        self.assertEqual(self.ctx['posts'].count('/repos/test/tasks/releases'), 2)

    def test_provision_rate_limit_and_explicit_rejected_retry(self):
        self.submit(); self.ctx['provision_mode']['issue'] = 'rate'
        self.poll('mac-outer'); self.poll('mac-outer')
        self.assertEqual(len(self.ctx['posts']), 1)
        self.clear_cooldown('mac-outer'); self.ctx['provision_mode']['issue'] = 'reject'
        self.poll('mac-outer')
        self.run_cli('mac-outer','RetryRejected','-Key','issue:smoke')
        self.ctx['provision_mode'].clear(); self.poll('mac-outer')
        self.assertEqual(len(self.ctx['issues']), 1)
        self.assertEqual(len(self.ctx['comments']), 1)

    def test_input_and_result_zip_are_scoped_to_run_and_content_hash(self):
        path = self.zip_path()
        first = self.run_cli('mac-outer','Upload','-Key',self.key,'-File',path)
        self.assertIn('/aic-v1.experiments-v1.smoke.r1.run-001/input--mac-outer--', first['url'])
        self.assertEqual(first, self.run_cli('mac-outer','Upload','-Key',self.key,'-File',path))
        self.task['artifacts'] = [first]; self.write_inputs(); self.ready()
        self.run_cli('windows-inner','Claim','-Key',self.key)
        result = self.run_cli('windows-inner','Upload','-Key',self.key,'-File',path)
        self.assertIn('/result--windows-inner--', result['url'])
        self.result['artifacts'] = [result]; self.write_inputs()
        self.run_cli('windows-inner','Complete','-Key',self.key,'-File',self.resultfile)
        self.poll('windows-inner'); self.poll('windows-inner'); self.poll('mac-outer')
        self.assertEqual(self.poll('mac-outer')['runs'][0]['phase'], 'receipt')
        self.assertTrue(all(x is None for x in self.ctx['artifact_auth']))
        self.task['run_id'] = 'run-002'
        second = self.run_cli('mac-outer','Upload','-Key','smoke/1/run-002','-File',path)
        self.assertNotEqual(first['url'], second['url'])
        self.task['artifacts'] = [second]; self.write_inputs(); self.submit(); self.poll('mac-outer')
        self.assertEqual(len(self.ctx['releases']), 2)
        self.assertEqual(len(self.ctx['release_assets']), 3)

    def test_wrong_run_artifact_and_missing_upload_key_fail_locally(self):
        path = self.zip_path()
        self.assertEqual(self.run_cli('mac-outer','Upload','-File',path,ok=False)['code'], 'RUN_KEY_REQUIRED')
        self.assertEqual(self.ctx['gets'], [])
        asset = self.run_cli('mac-outer','Upload','-Key',self.key,'-File',path)
        self.task['run_id'] = 'run-002'; self.task['artifacts'] = [asset]; self.write_inputs()
        self.assertEqual(self.run_cli('mac-outer','Submit','-File',self.taskfile,ok=False)['code'], 'ARTIFACT_RUN_MISMATCH')

    def test_release_metadata_mismatch_blocks_upload_and_publication(self):
        self.submit(); self.poll('mac-outer')
        release = next(iter(self.ctx['releases'].values()))
        release['body'] = release['body'].replace('"run_id":"run-001"', '"run_id":"other"')
        self.assertEqual(self.run_cli('mac-outer','Upload','-Key',self.key,'-File',self.zip_path(),ok=False)['code'], 'RELEASE_IDENTITY_MISMATCH')
        self.assertEqual(len(self.ctx['release_assets']), 0)

    def test_comment_pagination_failure_imports_no_partial_event(self):
        self.submit(); self.poll('mac-outer')
        for i in range(2, 101):
            self.ctx['comments'].append(dict(id=i, issue_number=1, body='human note', user=dict(login='outsider')))
        self.ctx['fail_page'] = 2
        self.run_cli('windows-inner','Poll',ok=False)
        self.assertEqual(self.read_state('windows-inner')['events'], {})

    def test_issue_pagination_failure_cannot_create_duplicate(self):
        self.submit(); self.poll('mac-outer')
        self.ctx['issues'] += [dict(number=i, body='human issue') for i in range(2,101)]
        self.ctx['issue_page_failure'] = 2
        self.run_cli('windows-inner','Poll',ok=False)
        self.assertEqual(self.read_state('windows-inner')['events'], {})
        self.run_cli('mac-outer','Poll',ok=False)
        self.assertEqual(self.ctx['posts'].count('/repos/test/tasks/issues'), 1)

    def test_changed_release_body_and_untrusted_author_are_not_reused(self):
        self.submit(); self.poll('mac-outer')
        release = next(iter(self.ctx['releases'].values()))
        original = release['body']
        release['body'] = original.replace('运行：', '修改：')
        self.assertEqual(self.run_cli('mac-outer','Upload','-Key',self.key,'-File',self.zip_path(),ok=False)['code'], 'RUN_RELEASE_CHANGED')
        release['body'] = original; release['author']['login'] = 'outsider'
        self.assertEqual(self.run_cli('mac-outer','Upload','-Key',self.key,'-File',self.zip_path(),ok=False)['code'], 'RELEASE_AUTHOR_NOT_ALLOWED')

    def test_platform_timestamps_normalize_offsets_to_utc(self):
        self.submit(); self.poll('mac-outer')
        self.ctx['comments'][0]['created_at']='2026-09-26T10:00:01+08:00'
        row=self.poll('windows-inner')['runs'][0]['timeline'][0]
        self.assertEqual(row['published_at'],'2026-09-26T02:00:01.000Z')


if __name__ == '__main__': unittest.main(verbosity=2)

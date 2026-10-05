#!/usr/bin/env python3
"""Read-only, content-free usage profile. All store paths and the UTC window are explicit.

Print JSON to stdout; never emit prompt text, tool arguments, results, or errors.
SQLite connections use mode=ro plus query_only and a read transaction. Broca
exports are a separate cohort, not additive to invocation totals.
"""
import argparse
import collections
import datetime as dt
import hashlib
import json
import math
import re
from pathlib import Path
import sqlite3
import statistics
import struct


def database(path):
    conn = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA query_only=ON')
    conn.execute('BEGIN')
    return conn


def millis(value):
    return int(dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)


def distribution(values):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    return {'n': len(values), 'median': statistics.median(values),
            'p90': values[math.ceil(.9 * len(values)) - 1], 'max': values[-1]}


def failure(error):
    text = (error or '').lower()
    for label, needles in [
        ('timeout', ['timed out', 'timeout']), ('cancelled', ['abort', 'cancel']),
        ('model_not_found', ['model', 'not found']),
        ('missing_run_id', ['active run_id']), ('empty_output', ['empty', 'no output']),
        ('manifest', ['manifest', 'root element', 'xml']),
    ]:
        if (all(n in text for n in needles) if label == 'model_not_found'
                else any(n in text for n in needles)):
            return label
    return 'other' if text else 'none'


def usage(tokens):
    cache = tokens.get('cache') or {}
    return [tokens.get('input', 0), cache.get('read', 0),
            cache.get('write', 0), tokens.get('output', 0), tokens.get('reasoning', 0)]


METRICS = ['input', 'cache_read', 'cache_write', 'output', 'reasoning']
CAPS = {'map-memories': 60, 'verify': 60, 'verify-broad': 60, 'curate': 150,
        'classify-memories': 4, 'retrospective': 40, 'maintain-docs': 60,
        'review-user-memories': 4, 'historian': 40}
TITLES = {'magic-context-compartment': 'historian',
          'magic-context-dream-classify': 'classify-memories',
          'magic-context-dream-user-memories': 'review-user-memories'}


def task_for(title):
    if title in TITLES:
        return TITLES[title]
    if title.startswith('magic-context-historian-'):
        return 'historian-rust'
    if title.startswith('magic-context-dream-'):
        return title.removeprefix('magic-context-dream-')
    if title.startswith('magic-context-smart-note-'):
        return 'evaluate-smart-notes'
    return None


def wal_records(path):
    with path.open('rb') as stream:
        expected = 1
        lineage = None
        while True:
            header = stream.read(53)
            if len(header) < 53:
                return
            length, version, seq, fence = struct.unpack('<IBQQ', header[:21])
            if length > 67108864 or version not in (1, 2):
                raise ValueError('invalid WAL frame')
            payload = stream.read(length)
            if len(payload) < length:
                return
            if hashlib.sha256(header[4:21] + payload).digest() != header[21:]:
                raise ValueError('WAL digest mismatch')
            if version == 2:
                if (length, seq, fence) != (16, 0, 0):
                    raise ValueError('invalid lineage frame')
                if lineage is not None and lineage != payload:
                    raise ValueError('WAL lineage changed')
                lineage = payload
                continue
            if seq != expected:
                raise ValueError('WAL sequence gap')
            expected += 1
            yield json.loads(payload)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['context', 'opencode', 'opencode2', 'pi', 'broca', 'wal', 'start', 'end']:
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    start, end = millis(args.start), millis(args.end)
    mc, oc, oc2, broca = map(database, [args.context, args.opencode, args.opencode2, args.broca])
    inv = [dict(r) for r in mc.execute("SELECT * FROM subagent_invocations WHERE started_at>=? AND started_at<? AND subagent IN ('dreamer','historian')", (start, end))]
    for r in inv:
        r['task'] = 'historian' if r['subagent'] == 'historian' else (r['task'] or 'unattributed')
        r['children'] = []
        r['units'] = []
        r['failure_kind'] = failure(r.pop('error'))
    # Link children by parent, task and creation time inside the invocation interval.
    # Exact token totals may break ties; otherwise ambiguous children stay unlinked.
    index = collections.defaultdict(list)
    for r in inv:
        index[r['session_id'], r['task']].append(r)
    children = []
    for row in oc.execute('SELECT id,parent_id,title,time_created FROM session WHERE time_created>=? AND time_created<?', (start, end)):
        task = task_for(row['title'])
        if not task:
            continue
        messages = list(oc.execute('SELECT id,data FROM message WHERE session_id=? ORDER BY time_created,id', (row['id'],)))
        steps, tools, seen = [], [], set()
        for m in messages:
            data = json.loads(m['data'])
            if data.get('role') != 'assistant':
                continue
            u = usage(data.get('tokens') or {})
            if not any(u):
                continue
            results = []
            for part in oc.execute('SELECT data FROM part WHERE message_id=? ORDER BY time_created,id', (m['id'],)):
                p = json.loads(part['data'])
                if p.get('type') != 'tool':
                    continue
                state = p.get('state') or {}
                output = state.get('output', '')
                size = len(output) if isinstance(output, str) else len(json.dumps(output))
                signature = (p.get('tool'), json.dumps(state.get('input'), sort_keys=True))
                arguments = state.get('input') or {}
                if not isinstance(arguments, dict):
                    arguments = {}
                result = {'tool': p.get('tool'), 'chars': size, 'repeat_args': signature in seen,
                          'unbounded_read': p.get('tool') == 'read' and not any(
                              k in arguments for k in ['offset', 'limit', 'startLine', 'endLine'])}
                seen.add(signature)
                results.append(result)
                tools.append(result)
            steps.append({'usage': u, 'prompt': sum(u[:3]), 'tools': results,
                          'model': data.get('modelID'), 'finish': data.get('finish')})
        model = next((json.loads(m['data']).get('modelID') for m in reversed(messages)
                      if json.loads(m['data']).get('modelID')), None)
        candidates = []
        for t in ([task, 'verify-broad'] if task == 'verify' else [task]):
            candidates += [r for r in index[row['parent_id'], t]
                           if r['harness'] == 'opencode' and r['started_at'] - 1000 <= row['time_created']
                           <= (r['ended_at'] or end)]
        totals = [sum(s['usage'][i] for s in steps) for i in range(5)]
        if len(candidates) > 1 and any(totals):
            exact = [r for r in candidates if [r[k] for k in
                     ['input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens']] == totals[:4]]
            if len(exact) == 1:
                candidates = exact
        child = {'id': row['id'], 'task': task, 'model': model, 'steps': steps,
                 'tokens': [sum(s['usage'][i] for s in steps) for i in range(5)],
                 'link': candidates[0]['id'] if len(candidates) == 1 else None}
        if len(candidates) == 1:
            candidates[0]['children'].append(child)
            child['task'] = candidates[0]['task']
        children.append(child)
    dream_links = 0
    dream_failures = collections.Counter()
    for row in mc.execute('SELECT * FROM dream_runs WHERE started_at>=? AND started_at<?', (start, end)):
        for task in json.loads(row['tasks_json']):
            if task.get('failure'):
                dream_failures[task['name'], task['failure'].get('failure_class', 'unknown')] += 1
            candidates = [r for r in index[row['parent_session_id'], task['name']]
                          if row['started_at'] - 1000 <= r['started_at'] <= row['finished_at']
                          and (r['ended_at'] or end) <= row['finished_at'] + 1000]
            if len(candidates) == 1:
                unit = task.get('backlog', {}).get('processed')
                if task['name'] in ['verify', 'verify-broad']:
                    match = re.search(r'processed (\d+) \(verified (\d+), updated (\d+), archived (\d+), skipped (\d+), refused (\d+)\)', task.get('progress', ''))
                    unit = sum(map(int, match.groups()[1:4])) if match else None
                if task['name'] not in ['verify', 'verify-broad', 'map-memories', 'classify-memories', 'review-user-memories']:
                    unit = None
                candidates[0]['units'].append(unit)
                dream_links += 1
    hist = list(mc.execute('SELECT * FROM historian_runs WHERE created_at>=? AND created_at<?', (start, end)))
    by_id = {r['id']: r for r in inv}
    for h in hist:
        if h['subagent_invocation_id'] in by_id:
            by_id[h['subagent_invocation_id']]['units'].append(h['compartments_produced'])
    groups = []
    for key in sorted({(r['harness'], r['task'], r['model_id'] or 'unknown') for r in inv}):
        rs = [r for r in inv if (r['harness'], r['task'], r['model_id'] or 'unknown') == key]
        linked = [r for r in rs if r['children']]
        positive_units = [r for r in rs if any(u is not None and u > 0 for u in r['units'])]
        keys = ['input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens']
        groups.append({'host': key[0], 'task': key[1], 'model': key[2], 'runs': len(rs),
                       'status': dict(collections.Counter(r['status'] for r in rs)),
                       'failure_kind': dict(collections.Counter(r['failure_kind'] for r in rs if r['status'] != 'completed')),
                       'tokens': {k: distribution([r[k] for r in rs]) for k in keys},
                       'total_tokens': {k: sum(r[k] for r in rs) for k in keys},
                       'wall_s': distribution([(r['ended_at']-r['started_at'])/1000 for r in rs if r['ended_at']]),
                       'linked_runs': len(linked),
                       'steps': distribution([sum(len(c['steps']) for c in r['children']) for r in linked]),
                       'unit_runs': len(positive_units),
                       'units': sum(sum(u or 0 for u in r['units']) for r in positive_units),
                       'tokens_per_unit': (sum(sum(r[k] for k in keys) for r in positive_units) /
                                           sum(sum(u or 0 for u in r['units']) for r in positive_units)) if positive_units else None})
    # Sum segments within each run before quantiles so multi-segment runs count once.
    exports = collections.defaultdict(list)
    missing_export_time = 0
    for row in broca.execute('SELECT segment_json FROM export_facts'):
        fact = json.loads(row[0])
        sid = fact['session']['session']
        if not sid.startswith(('mc-historian:', 'mc-dreamer:')):
            continue
        when = fact.get('occurred_at_ms')
        if when is None:
            missing_export_time += 1
        elif start <= when < end:
            exports[fact['run_id']].append(fact)
    export_groups = collections.defaultdict(list)
    for run, facts in exports.items():
        f = facts[0]
        task = 'historian' if f['session']['session'].startswith('mc-historian:') else 'classify-memories'
        export_groups[task, f['session']['harness'], f.get('model')].append({
            'run': run, 'terminal': facts[-1].get('terminal_reason'),
            'usage': {k: sum(x.get('usage', {}).get(k, 0) for x in facts)
                      for k in ['input_tokens', 'cached_input_tokens', 'cache_write_tokens', 'output_tokens', 'reasoning_tokens']}})
    wal_summary = collections.Counter()
    wal_runs = []
    # Read only the WAL addresses named by the selected export facts.
    addresses = set()
    for facts in exports.values():
        s = facts[0]['session']
        h = 0xcbf29ce484222325
        for byte in '\x1f'.join(s[k] for k in ['project_root', 'harness', 'session']).encode():
            h = ((h ^ byte) * 0x100000001b3) & 0xffffffffffffffff
        addresses.add(f'{h:016x}')
    for address in sorted(addresses):
        path = Path(args.wal) / (address + '.wal')
        if not path.exists():
            wal_summary['missing_or_archived'] += 1
            continue
        current = None
        for record in wal_records(path):
            wal_summary[record['type']] += 1
            if record['type'] == 'run_started':
                current = {'run': record['run_id'], 'steps': [], 'start': record.get('ts_ms'),
                           'stop_when': record.get('config', {}).get('stop_when')}
                if current['run'] in exports:
                    wal_runs.append(current)
            elif current is not None and record['type'] == 'model_step_finished':
                current['steps'].append(record.get('usage'))
            elif current is not None and record['type'] == 'run_finished':
                current['end'] = record.get('ts_ms')
                current['reason'] = record.get('reason')
    pi_headers = []
    pi_counts = collections.Counter()
    for path in Path(args.pi).rglob('*.jsonl'):
        with path.open() as stream:
            for line in stream:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    pi_counts['malformed_lines'] += 1
                    continue
                if record.get('type') == 'session':
                    timestamp = record.get('timestamp')
                    if not timestamp or not start <= millis(timestamp) < end:
                        break
                    pi_counts['sessions'] += 1
                    if '/T/pi-runtime-' in record.get('cwd', ''):
                        pi_counts['test_sessions'] += 1
                    pi_headers.append(record.get('id'))
                message = record.get('message', {})
                if message.get('role') == 'assistant':
                    pi_counts['assistant_messages'] += 1
    result = {'window': [args.start, args.end], 'invocations': len(inv), 'groups': groups,
              'dream_links': dream_links,
              'dream_failure_classes': [{'task': k[0], 'kind': k[1], 'n': n} for k, n in sorted(dream_failures.items())],
              'historian_rows': len(hist),
              'oc2_message_types': [dict(r) for r in oc2.execute('SELECT type,count(*) AS n FROM session_message GROUP BY type')],
              'pi': dict(pi_counts), 'pi_parent_id_matches': sum(r['session_id'] in pi_headers for r in inv if r['harness']=='pi'),
              'child_count': len(children), 'linked_children': sum(c['link'] is not None for c in children),
              'child_groups': [], 'top_invocations': [],
              'top_children': sorted(children, key=lambda c: sum(c['tokens'][:4]), reverse=True)[:5],
              'exports_missing_timestamp': missing_export_time, 'exports': [],
              'wal_summary': dict(wal_summary), 'wal_runs': wal_runs}
    for key in sorted({(c['task'], c['model'] or 'unknown') for c in children}):
        cs = [c for c in children if (c['task'], c['model'] or 'unknown') == key]
        nonempty = [c for c in cs if c['steps']]
        prompts = [[s['prompt'] for s in c['steps'] if s['prompt'] > 0] for c in nonempty]
        prompts = [p for p in prompts if p]
        tools = collections.defaultdict(lambda: [0, 0, 0, 0, 0])
        for c in cs:
            for s in c['steps']:
                for t in s['tools']:
                    value = tools[t['tool']]
                    value[0] += 1
                    value[1] += t['chars']
                    value[2] += int(t['repeat_args'])
                    value[3] += int(t['unbounded_read'])
                    value[4] += t['chars'] if t['unbounded_read'] else 0
        result['child_groups'].append({'task': key[0], 'model': key[1], 'children': len(cs), 'with_usage': len(nonempty),
                                      'steps': distribution([len(c['steps']) for c in nonempty]),
                                      'mixed_model_children': sum(len({s['model'] for s in c['steps'] if s['model']}) > 1 for c in nonempty),
                                      'step_histogram': dict(collections.Counter(len(c['steps']) for c in nonempty)),
                                      'near_current_cap': sum(len(c['steps']) >= .9 * CAPS[key[0]] for c in nonempty) if key[0] in CAPS else None,
                                      'first_prompt': distribution([p[0] for p in prompts]),
                                      'growth_per_step': distribution([(p[-1]-p[0])/(len(p)-1) for p in prompts if len(p)>1]),
                                      'tokens': [sum(c['tokens'][i] for c in cs) for i in range(5)], 'tools': dict(tools)})
    for r in sorted(inv, key=lambda r: sum(r[k] for k in ['input_tokens','cache_read_tokens','cache_write_tokens','output_tokens']), reverse=True)[:5]:
        result['top_invocations'].append({k: v for k, v in r.items() if k not in ['children', 'session_id']} | {'children': [c['id'] for c in r['children']]})
    wal_by_run = {r['run']: r for r in wal_runs}
    for key, runs in sorted(export_groups.items()):
        observed = [wal_by_run[r['run']] for r in runs if r['run'] in wal_by_run]
        result['exports'].append({'task': key[0], 'host': key[1], 'model': key[2], 'runs': len(runs),
                                  'terminal': dict(collections.Counter(r['terminal'] for r in runs)),
                                  'steps': distribution([len(r['steps']) for r in observed]),
                                  'wall_s': distribution([(r['end']-r['start'])/1000 for r in observed if r.get('start') is not None and r.get('end') is not None]),
                                  'usage': {k: distribution([r['usage'][k] for r in runs]) for k in runs[0]['usage']}})
    step_models = collections.defaultdict(lambda: [0] * 6)
    for child in children:
        for step in child['steps']:
            totals = step_models[child['task'], step['model'] or 'unknown']
            totals[0] += 1
            for i, value in enumerate(step['usage']):
                totals[i + 1] += value
    result['step_model_totals'] = [
        {'task': task, 'model': model, 'records': values[0], 'usage': values[1:]}
        for (task, model), values in sorted(step_models.items())]
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()

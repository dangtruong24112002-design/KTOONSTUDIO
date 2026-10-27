"""Read-only cost-per-usable-minute statistics from jobs and local MP4 headers."""
import struct
from pathlib import Path


def mp4_seconds(path):
    try:
        with path.open('rb') as f:
            def boxes(start, end, depth=0):
                pos = start
                while pos+8 <= end:
                    f.seek(pos); head = f.read(8)
                    if len(head) != 8: return None
                    size, kind = struct.unpack('>I4s', head); offset = 8
                    if size == 1:
                        ext = f.read(8)
                        if len(ext) != 8: return None
                        size = struct.unpack('>Q', ext)[0]; offset = 16
                    if size == 0: size = end-pos
                    if size < offset or pos+size > end: return None
                    if kind == b'mvhd':
                        data = f.read(min(40, size-offset))
                        if len(data) < 20: return None
                        if data[0] == 1 and len(data) >= 32:
                            scale, duration = struct.unpack('>IQ', data[20:32])
                        elif data[0] == 0:
                            scale, duration = struct.unpack('>II', data[12:20])
                        else: return None
                        return duration/scale if scale else None
                    if kind == b'moov' and depth < 2:
                        value = boxes(pos+offset, pos+size, depth+1)
                        if value is not None: return value
                    pos += size
            return boxes(0, path.stat().st_size)
    except (OSError, ValueError, struct.error):
        return None


def analyze(jobs, data_dir, usable_rate=.5):
    if not 0 < usable_rate <= 1: raise ValueError('Usable rate must be greater than 0 and at most 1.')
    data_dir = Path(data_dir).resolve()
    rows = list(jobs.values()) if isinstance(jobs, dict) else list(jobs)
    dated = [j for j in rows if j.get('created')]
    categories = {k: {'jobs': 0, 'done': 0, 'failed': 0, 'running': 0, 'cost': 0.0} for k in ('llm', 'image', 'video', 'upscale')}
    days, videos, unknown, legacy_failed = {}, [], [], []
    for j in dated:
        kind, status = j.get('kind'), j.get('status')
        if kind not in categories: continue
        c = categories[kind]; c['jobs'] += 1
        if status in ('done', 'failed', 'running'): c[status] += 1
        # Running jobs and uncertain charges cannot enter a completed-output unit-cost ratio.
        cost = float(j.get('cost') or 0) if status == 'done' and not j.get('billing_unknown') else 0.0
        if status == 'failed' and j.get('cost_basis') in ('usage_estimate', 'tariff_estimate') and not j.get('billing_unknown'):
            cost = float(j.get('cost') or 0)
        c['cost'] += cost
        day = j['created'][:10]
        days.setdefault(day, {'llm': 0.0, 'image': 0.0, 'video': 0.0, 'upscale': 0.0, 'generated_seconds': 0.0})[kind] += cost
        if j.get('billing_unknown') or 'UNKNOWN_SUBMISSION' in (j.get('error') or '') or (status == 'failed' and 'timed out' in (j.get('error') or '').lower()):
            unknown.append({'id': j.get('id'), 'kind': kind, 'date': j['created'], 'logged_cost': float(j.get('cost') or 0), 'estimate': float(j.get('est') or 0)})
        elif status == 'failed' and j.get('pid'):
            legacy_failed.append({'id': j.get('id'), 'kind': kind, 'date': j['created'], 'logged_cost': float(j.get('cost') or 0)})
        if kind != 'video' or status != 'done': continue
        media = (j.get('output') or {}).get('video') or {}
        file = (data_dir / (media.get('file') or '')).resolve()
        seconds = mp4_seconds(file) if data_dir in file.parents and file.is_file() else None
        source = 'mp4_header'
        if seconds is None:
            seconds = float(media.get('duration') or j.get('dur') or 0)
            source = 'job_duration' if seconds else 'missing'
        if seconds < 0: seconds, source = 0, 'missing'
        days[day]['generated_seconds'] += seconds
        videos.append({'id': j.get('id'), 'date': j['created'], 'model': j.get('model'), 'cost': cost,
                       'seconds': round(seconds, 4), 'requested_seconds': j.get('dur'), 'duration_source': source})
    generated = sum(v['seconds'] for v in videos)
    usable = generated*usable_rate
    total = sum(c['cost'] for c in categories.values())
    for c in categories.values():
        c['cost'] = round(c['cost'], 6)
        c['per_usable_minute'] = round(c['cost']*60/usable, 6) if usable else None
    for values in days.values():
        for k, v in values.items(): values[k] = round(v, 6)
    return {'date_from': min((j['created'][:10] for j in dated), default=None), 'date_to': max((j['created'][:10] for j in dated), default=None),
            'usable_rate': usable_rate, 'categories': categories, 'days': dict(sorted(days.items())), 'videos': videos,
            'total_cost': round(total, 6), 'generated_seconds': round(generated, 4), 'usable_seconds': round(usable, 4),
            'per_generated_minute': round(total*60/generated, 6) if generated else None,
            'per_usable_minute': round(total*60/usable, 6) if usable else None,
            'unknown_billing': unknown, 'other_failed_with_provider_id': legacy_failed,
            'running_jobs': sum(j.get('status') == 'running' for j in dated),
            'note': 'Historical app costs, not provider invoices. All recorded LLM/image costs are allocated to all completed generated video. 50% is a planning assumption, not measured approval quality. Excludes external uploads, human editing and uncertain/running charges.'}

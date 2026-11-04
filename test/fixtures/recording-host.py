"""Test-only stand-in for Kinex's rosbag recording host control channel."""
import json
import pathlib
import sys

count = 0
directory = None
for line in sys.stdin:
    request = json.loads(line)
    count += 1
    if 'catalog' in request:
        directory = pathlib.Path(request['dir'])
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'samples.jsonl').write_text('')
        result = {'ready': True, 'status': 'recording'}
    elif request.get('action') == 'stop':
        result = {'done': True, 'status': 'stopped'}
    else:
        result = {'status': 'recording'}
    result.update(samples=count, bag=str(directory / 'bag') if directory else None)
    print(json.dumps(result), flush=True)
    if result.get('done'):
        break

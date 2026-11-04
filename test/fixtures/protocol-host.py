"""Test-only stand-in for a Kinex ROS device host's JSON-lines control channel."""
import concurrent.futures
import json
import os
from pathlib import Path
import sys
import threading

lock = threading.Lock()
requests = {}
state = {'calls': 0, 'loaded': False, 'stopped': False}
# The host runs in its device directory; a `load-delay` file there slows activation.
delay = Path('load-delay')


def emit(value):
    with lock:
        print(json.dumps(value), flush=True)


def run(request):
    action, args = request['action'], request.get('args', {})
    cancelled = requests[request['id']]
    try:
        with lock:
            state['calls'] += 1
        if action == 'stop':
            state['stopped'] = True
        if action == 'load' and delay.exists() and cancelled.wait(float(delay.read_text())):
            raise InterruptedError('cancelled')
        if action == 'load':
            state['loaded'] = True
        if args.get('busy'):
            Path(args['busy']).write_text(str(os.getpid()))
        if cancelled.wait(args.get('sleep', 0)):
            raise InterruptedError('cancelled')
        result = {'ready': state['loaded'], 'faults': [], 'stopped': state['stopped'], 'value': 1, 'pid': os.getpid(), 'calls': state['calls']}
        emit({'id': request['id'], 'ok': True, 'data': result})
    except Exception as error:
        emit({'id': request['id'], 'ok': False, 'error': str(error)})
    finally:
        requests.pop(request['id'], None)


with concurrent.futures.ThreadPoolExecutor() as pool:
    for line in sys.stdin:
        request = json.loads(line)
        if 'cancel' in request:
            event = requests.get(request['cancel'])
            if event:
                event.set()
            continue
        requests[request['id']] = threading.Event()
        pool.submit(run, request)
    for event in list(requests.values()):
        event.set()

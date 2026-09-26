"""Shared network hardening for every PubChem call in the app
(pubchem.py and routers/symmetry.py both import this).

ROOT CAUSE of the "PubChem fetch just hangs forever, nothing in the logs
after 'requested'" bug: every PubChem call already had a `timeout=(4, 9)`
tuple plus a bounded retry count, so the *intended* worst case was well
under a minute. But `requests`/`urllib3`'s `timeout` only covers the
socket connect + read phases. DNS resolution (`socket.getaddrinfo()`)
happens *before* any of that, at the C-library level, with no timeout
applied at all. On Render (and most containers), if the resolver tries
an AAAA (IPv6) record first and the container's IPv6 route is dead —
extremely common — that lookup can silently stall far longer than any
`timeout=` we pass, which is exactly the multi-minute hang seen in the
logs (a "requested" line with no "succeeded"/failed"/error line ever
following it, across three separate attempts).

Two independent fixes, applied together:

1. Force IPv4-only DNS resolution for every `requests` call in the app
   (monkeypatches urllib3's `allowed_gai_family`, the officially
   documented hook for this — not a private hack). This removes the
   actual cause.
2. `run_with_deadline()` — a hard, wall-clock cap enforced from *outside*
   the network call, as a safety net for this class of bug in general
   (DNS stalls, a hung proxy, anything that ignores `timeout=`). No
   amount of tuning inside `requests` can bound something at that layer;
   only an external watchdog can. If the wrapped call doesn't finish in
   time we give up and return an error to the user instead of hanging
   the request forever — the underlying thread is abandoned (Python has
   no safe way to kill a thread mid-syscall) but the user gets a fast,
   honest answer instead of a spinner that never resolves.
"""
import socket
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as _FutureTimeoutError

import urllib3.util.connection as _urllib3_conn

_original_allowed_gai_family = _urllib3_conn.allowed_gai_family


def _ipv4_only_gai_family():
    return socket.AF_INET


# Applied at import time. Both pubchem.py and routers/symmetry.py import
# this module before making any request, so this runs once per process
# and covers every PubChem call in the app, including any added later.
_urllib3_conn.allowed_gai_family = _ipv4_only_gai_family


class DeadlineExceeded(Exception):
    """A blocking call didn't return within our hard wall-clock cap, even
    though it should have already given up on its own via its internal
    `timeout=`. Treat this the same as "PubChem unreachable" — it means
    something below the HTTP layer (most likely DNS) stalled instead of
    failing outright."""


# A handful of dedicated threads for deadline-wrapped calls. Kept small
# and separate from Starlette's own threadpool (which runs the sync route
# handlers) so a leaked, still-hung thread here — which can happen, since
# there's no safe way to force-kill a thread stuck in a syscall — can
# never starve request handling itself.
_deadline_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="pubchem-deadline")


def run_with_deadline(fn, *args, timeout: float, **kwargs):
    """Run fn(*args, **kwargs) with a hard wall-clock cap. Returns fn's
    result, or re-raises whatever exception fn raised, unchanged. If fn
    hasn't finished within `timeout` seconds, raises DeadlineExceeded and
    abandons the underlying thread rather than waiting on it further."""
    future = _deadline_pool.submit(fn, *args, **kwargs)
    try:
        return future.result(timeout=timeout)
    except _FutureTimeoutError:
        raise DeadlineExceeded(
            f"Timed out after {timeout:.0f}s waiting on {getattr(fn, '__name__', fn)!r} "
            "-- this looks like a DNS/network stall rather than PubChem itself "
            "returning an error."
        )
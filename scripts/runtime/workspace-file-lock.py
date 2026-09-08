#!/usr/bin/env python3
"""Acquire flock on a descriptor owned by the Node.js parent, then exit.

The parent passes its open file description as fd3 and keeps its descriptor
open through the mutation. Do not unlock explicitly: dup/fork references share
one flock, which is released only after the last reference closes.

Linux: https://man7.org/linux/man-pages/man2/flock.2.html
macOS: https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html
"""

import fcntl
import signal
import sys

# Bound orphan waiters even if the Node parent is killed during acquisition.
# The parent's own deadline kills and reaps the helper during normal operation.
signal.alarm(30)
fcntl.flock(3, fcntl.LOCK_EX)
signal.alarm(0)
sys.stdout.write("locked\n")

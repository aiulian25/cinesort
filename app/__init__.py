"""CineSort application package.

Single source of truth for the version on the Python side. Deliberately
import-free and side-effect-free: this module runs on every `import app.*` —
including the Docker build's label consistency check — so it must never do I/O
or read the environment.

Bump together with package.json (electron-builder's source, which cannot import
Python) and the README badge; tests/test_version.py fails when they disagree.
"""

__version__ = "1.6.1"

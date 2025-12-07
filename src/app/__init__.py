# pywrangler automatically installs all dependencies from pyproject.toml into python_modules/
# No manual vendoring needed - all packages are provided by pywrangler

# CRITICAL: Disable urllib3's emscripten module BEFORE any imports
# It tries to use XMLHttpRequest which doesn't exist in Cloudflare Workers
import sys
from types import ModuleType

try:
    # Create dummy modules to block urllib3.contrib.emscripten
    # Using None causes "None in sys.modules" error
    dummy = ModuleType('urllib3.contrib.emscripten')
    dummy.inject_into_urllib3 = lambda: None  # No-op function
    sys.modules['urllib3.contrib.emscripten'] = dummy
    sys.modules['urllib3.contrib.emscripten.connection'] = ModuleType('connection')
    sys.modules['urllib3.contrib.emscripten.fetch'] = ModuleType('fetch')
except Exception:
    pass

try:
    import js  # type: ignore
    JS_RUNTIME = True
except ImportError:
    JS_RUNTIME = False

try:
    from .webdav import HAS_NATIVE_WEBDAV
except ImportError:
    try:
        from webdav import HAS_NATIVE_WEBDAV  # type: ignore
    except ImportError:
        HAS_NATIVE_WEBDAV = False  # type: ignore


# Patch requests to use Cloudflare Workers fetch API only when we cannot rely on native WebDAV
if JS_RUNTIME and not HAS_NATIVE_WEBDAV:
    try:
        from .fetch_adapter import patch_requests_with_fetch
        patch_requests_with_fetch()
    except ImportError:
        try:
            from fetch_adapter import patch_requests_with_fetch
            patch_requests_with_fetch()
        except Exception as e:
            from .logger import log
            log(f"[Init] Fetch adapter not available: {e}")
            # Fallback to pyodide-http (for local dev)
            try:
                import pyodide_http
                pyodide_http.patch_all()
                log("[Init] Fallback to pyodide-http")
            except Exception:
                pass

# Keep this for backward compatibility
def ensure_http_patched():
    """Compatibility function - patch is already applied at module init."""
    pass

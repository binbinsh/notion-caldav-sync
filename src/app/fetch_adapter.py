"""
Custom HTTP adapter for requests library that uses Cloudflare Workers fetch API.
This replaces pyodide-http which requires XMLHttpRequest (not available in Workers).
"""

from requests.adapters import BaseAdapter
from requests.models import Response as RequestsResponse
from requests.structures import CaseInsensitiveDict

from .logger import log


def _await_promise_blocking(promise):
    """
    Wait for a JS Promise by using Atomics.wait on a SharedArrayBuffer.

    Pyodide removed run_sync on the Workers runtime, so we emulate the same
    behaviour to keep the requests adapter synchronous.
    """
    from js import SharedArrayBuffer, Int32Array, Atomics
    from pyodide.ffi import JsException, create_proxy

    sab = SharedArrayBuffer.new(4)
    state = Int32Array.new(sab)
    result_box = {}
    error_box = {}

    def _resolve(value):
        result_box["value"] = value
        Atomics.store(state, 0, 1)
        Atomics.notify(state, 0)

    def _reject(reason):
        error_box["value"] = reason
        Atomics.store(state, 0, 2)
        Atomics.notify(state, 0)

    resolve_proxy = create_proxy(_resolve)
    reject_proxy = create_proxy(_reject)
    promise.then(resolve_proxy, reject_proxy)

    try:
        while True:
            current = Atomics.load(state, 0)
            if current == 0:
                Atomics.wait(state, 0, 0)
                continue
            if current == 1:
                return result_box.get("value")
            raise JsException(error_box.get("value"))
    finally:
        resolve_proxy.destroy()
        reject_proxy.destroy()


class CloudflareFetchAdapter(BaseAdapter):
    """
    HTTP adapter that uses Cloudflare Workers fetch API.
    
    This is necessary because:
    1. Cloudflare Workers don't have XMLHttpRequest
    2. They don't support native sockets
    3. pyodide-http requires XMLHttpRequest
    
    We use the fetch API which is available in Workers.
    """
    
    def send(self, request, stream=False, timeout=None, verify=True, cert=None, proxies=None):
        """Send a PreparedRequest using fetch API."""
        from js import fetch, Object, Uint8Array
        from pyodide.ffi import to_js, JsException

        # Prepare fetch options  
        options = Object.new()
        options.method = request.method
        
        # Set headers
        if request.headers:
            options.headers = to_js(dict(request.headers))
        
        # Set body if present
        if request.body:
            options.body = to_js(request.body)
        
        try:
            # Call fetch - returns a Promise
            fetch_promise = fetch(request.url, options)

            js_response = _await_promise_blocking(fetch_promise)

            status = int(js_response.status)

            headers_dict = {}
            header_entries = js_response.headers.entries()
            while True:
                next_item = header_entries.next()
                if bool(next_item.done):
                    break
                pair = next_item.value
                headers_dict[str(pair[0])] = str(pair[1])

            body_buffer = _await_promise_blocking(js_response.arrayBuffer())
            body_bytes = bytes(Uint8Array.new(body_buffer).to_py())

        except JsException as e:
            from requests import ConnectionError
            raise ConnectionError(f"Fetch failed (JS): {e}", request=request)
        except Exception as e:
            from requests import ConnectionError
            raise ConnectionError(f"Fetch failed: {e}", request=request)
        
        # Build requests Response object
        response = RequestsResponse()
        response.status_code = status
        response.headers = CaseInsensitiveDict(headers_dict)
        response._content = body_bytes
        response.encoding = response.headers.get('content-type', '').split('charset=')[-1] if 'charset=' in response.headers.get('content-type', '') else None
        response.reason = 'OK' if 200 <= status < 300 else 'Error'
        response.url = request.url
        response.request = request
        
        return response
    
    def close(self):
        """Clean up adapter resources."""
        pass


def patch_requests_with_fetch():
    """
    Patch requests library to use Cloudflare Workers fetch API.
    This replaces the default HTTPAdapter with our CloudflareFetchAdapter.
    """
    import requests
    
    from .logger import log
    log("[FetchAdapter] Patching requests to use Cloudflare fetch API...")
    
    # Save original init
    if not hasattr(requests.sessions.Session, '_cf_original_init'):
        requests.sessions.Session._cf_original_init = requests.sessions.Session.__init__
    
    def new_init(self):
        # Call original init
        self._cf_original_init()
        # Mount our fetch adapter for http and https
        self.mount("https://", CloudflareFetchAdapter())
        self.mount("http://", CloudflareFetchAdapter())
    
    requests.sessions.Session.__init__ = new_init
    
    log("[FetchAdapter] Requests patched with CloudflareFetchAdapter")

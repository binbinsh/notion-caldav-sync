import inspect

from src.app.worker import Default


def test_queue_entrypoint_accepts_cloudflare_runtime_arguments():
    assert list(inspect.signature(Default.queue).parameters) == [
        "self",
        "batch",
        "env",
        "ctx",
    ]

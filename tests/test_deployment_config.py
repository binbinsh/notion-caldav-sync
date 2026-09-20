from pathlib import Path


def test_cron_dispatcher_polls_more_often_than_the_sync_interval():
    for filename in (
        "wrangler.toml-example",
        "wrangler.personal.toml-example",
    ):
        document = Path(filename).read_text()
        assert 'crons = ["*/5 * * * *"]' in document


def test_personal_setup_retrieves_the_webhook_verification_token():
    document = Path("scripts/setup-cloudflare.sh").read_text()
    assert '"${WORKER_URL%/}/admin/settings"' in document
    assert 'get("webhook_verification_token", "")' in document

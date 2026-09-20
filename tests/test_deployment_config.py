from pathlib import Path

from scripts.deploy_helpers import cmd_render_template


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


def test_templates_allow_workers_dev_without_a_custom_route():
    for filename in (
        "wrangler.toml-example",
        "wrangler.personal.toml-example",
    ):
        document = Path(filename).read_text()
        assert "workers_dev = ${WORKERS_DEV}" in document
        assert "WORKER_CUSTOM_DOMAIN" not in document


def test_setup_makes_custom_domain_optional_but_requires_webhook():
    document = Path("scripts/setup-cloudflare.sh").read_text()
    assert "press Enter to use Cloudflare's free workers.dev URL" in document
    assert 'confirm "Configure the optional Notion webhook now?"' not in document
    assert "Notion webhook setup is required for real-time sync" in document

    readme = Path("README.md").read_text()
    assert "Webhooks are optional" not in readme
    assert "**Webhooks (optional)**" not in readme


def test_noninteractive_deploy_defaults_status_style():
    document = Path("deploy.sh").read_text()
    assert 'STATUS_EMOJI_STYLE="emoji"' in document
    assert "STATUS_EMOJI_STYLE is required in non-interactive mode" not in document


def test_render_template_uses_environment(monkeypatch, tmp_path, capsys):
    template = tmp_path / "wrangler.toml-example"
    template.write_text("workers_dev = ${WORKERS_DEV}\n")
    monkeypatch.setenv("WORKERS_DEV", "true")

    assert cmd_render_template(template) == 0
    assert capsys.readouterr().out == "workers_dev = true\n"

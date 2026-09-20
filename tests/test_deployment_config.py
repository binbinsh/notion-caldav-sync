import subprocess
from pathlib import Path

from scripts.deploy_helpers import cmd_render_template, cmd_secret_exists


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
    assert "Enter uses workers.dev or keeps the saved value" in document
    assert 'confirm "Configure the optional Notion webhook now?"' not in document
    assert "Notion webhook setup is required for real-time sync" in document
    assert 'confirm "Run one full sync now?"' not in document
    assert "Running the first full sync now." in document

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


def test_secret_exists_reads_wrangler_json():
    document = '[{"name":"CREDENTIAL_VAULT_KEY","type":"secret_text"}]'

    assert cmd_secret_exists("CREDENTIAL_VAULT_KEY", document) == 0
    assert cmd_secret_exists("MISSING", document) == 1


def test_deployment_scripts_do_not_execute_env_files():
    for filename in (
        "deploy.sh",
        "scripts/provision-hosted-cloudflare.sh",
        "scripts/configure-notion-webhook.sh",
    ):
        document = Path(filename).read_text()
        assert 'source "$ROOT_DIR/.env"' not in document
        assert '. "$ENV_FILE"' not in document
        assert 'load_env_file "$ENV_FILE"' in document


def test_env_loader_treats_values_as_data(tmp_path):
    marker = tmp_path / "must-not-exist"
    env_file = tmp_path / ".env"
    env_file.write_text(
        f'SAFE=value with spaces\nQUOTED="demo-token"\nMALICIOUS=$(touch {marker})\n',
        encoding="utf-8",
    )

    result = subprocess.run(
        [
            "bash",
            "-c",
            'source scripts/load-env.sh; load_env_file "$1"; printf "%s\\n%s\\n%s" "$SAFE" "$QUOTED" "$MALICIOUS"',
            "bash",
            str(env_file),
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    assert result.stdout.startswith("value with spaces\ndemo-token\n$(touch ")
    assert not marker.exists()


def test_hosted_deploy_preserves_remote_secrets_and_mode():
    deploy = Path("deploy.sh").read_text()
    provision = Path("scripts/provision-hosted-cloudflare.sh").read_text()

    assert 'remote_secret_exists "$key"' in deploy
    assert "put_secret_if_present CREDENTIAL_VAULT_KEY" in deploy
    assert "upsert_env DEPLOYMENT_MODE hosted" in provision
    assert "! remote_secret_exists CREDENTIAL_VAULT_KEY" in provision
    setup = Path("scripts/setup-cloudflare.sh").read_text()
    assert "CREDENTIAL_VAULT_KEY=$(openssl" not in setup

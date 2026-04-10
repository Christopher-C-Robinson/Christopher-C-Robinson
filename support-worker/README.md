# BingoFlow Support Worker

This Cloudflare Worker receives public support submissions from the BingoFlow site and creates private issues in the Bingo repository.

## GitHub App setup

When you create the GitHub App, use these values:

- `GitHub App name`: `BingoFlow Support Intake`
- `Homepage URL`: `https://christopher-c-robinson.github.io/Christopher-C-Robinson/projects/bingoflow/`
- `Callback URL`: leave blank
- `Request user authorization (OAuth) during installation`: leave unchecked
- `Enable Device Flow`: leave unchecked
- `Setup URL`: leave blank
- `Webhook`: turn off `Active`
- `Webhook URL`: leave blank
- `Webhook secret`: leave blank
- `Repository permissions -> Issues`: `Read and write`
- `Installation target`: `Only on this account`

After registration:

1. Click `Generate a private key` and keep the downloaded PEM file.
2. Install the app on the private `Bingo` repository.
3. Copy the installation ID from the installation settings URL.
4. Use the app ID, installation ID, and PEM contents as Worker secrets.

## What it does

1. Accepts the form post from `docs/projects/bingoflow/support/`.
1. Rejects spammy submissions with a honeypot and origin checks.
1. Signs a GitHub App JWT and exchanges it for an installation token.
1. Creates a private issue in the Bingo repo.
1. Adds lightweight support labels.
1. Redirects the user back to the public receipt page.

## Required Cloudflare secrets

Set these with `wrangler secret put`:

- `GITHUB_APP_ID`
- `GITHUB_INSTALLATION_ID`
- `GITHUB_PRIVATE_KEY`

The private key must be the PEM contents of the GitHub App private key file.

Use the GitHub App ID, not the client ID, for `GITHUB_APP_ID`.

## Runtime variables

`wrangler.toml` already sets the private Bingo repo, allowed origins, and receipt URL.

If you need to change them later:

- `GITHUB_REPO_OWNER`
- `GITHUB_REPO_NAME`
- `RECEIPT_URL`
- `ALLOWED_ORIGINS`
- `SUPPORT_LABELS`

## Local development

```bash
npx wrangler@latest dev
```

The worker will listen for `POST /submit` requests during local testing.

## Deploy

```bash
npx wrangler@latest deploy
```

After deployment, copy the worker URL into
[`docs/projects/bingoflow/support/index.html`](../docs/projects/bingoflow/support/index.html)
or the support config file before publishing the profile site.

# ticket-scraper

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run start title <url>
bun run start agent "<task>"
bun run start watch <event-url>... [--every 15] [--once]
```

`watch` has the agent read each event page's availability, every 15 minutes (at least 5), and prints plus notifies on every change. A page behind a bot check, captcha or waiting room is reported as a failed check, never as sold out; `--once` exits non-zero when any check fails. Results are kept in `~/.ticket-scraper/watch.json` (override with `WATCH_STATE_FILE`).

The agent calls the `AZURE_OPENAI_DEPLOYMENT` (default `gpt-5.1`) on Azure AI Foundry as the signed-in `az` CLI user, so run `az login` first.

Secrets the agent may type into pages come from `SECRET_<NAME>` variables, for example in a gitignored `.env`. Pin each one to the sites it belongs on with `SECRET_<NAME>_ORIGINS=https://example.com`; an unpinned secret can be entered on any page, including one that asks for it in its text.

This project was created using `bun init` in bun v1.4.2. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

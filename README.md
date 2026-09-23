# ticket-scraper

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run start title <url>
bun run start agent "<task>"
bun run start watch <event-url>... [--every 15] [--once] [--until on_sale]...
bun run start seats <event-url> [--json]
```

`watch` has the agent read each event page's availability, every 15 minutes (at least 5), and prints plus notifies on every change. A page behind a bot check, captcha or waiting room is reported as a failed check, never as sold out; `--once` exits non-zero when any check fails. With `--until <status>` (`on_sale`, `sold_out`, `not_yet_on_sale` or `resale_only`, repeatable), each page is polled until its status is one of those, notified, and dropped; `watch` exits once every page has reached one. Results are kept in `~/.ticket-scraper/watch.json` (override with `WATCH_STATE_FILE`).

`seats` picks the seat provider for the URL's site, opens the event's seating chart and lists the free seats: a count per price category and per row, or every seat with `--json`. Providers live in `src/providers/` and implement `SeatProvider` from `src/seats.ts`; add one to `providers` there to support another site. The only one so far reads Fnac Spectacles through the Eventim seat map API behind its seating chart. `position` is the seat's order within its row on the map, not the number printed on the ticket.

Pages open in Microsoft Edge from `/Applications`, signed in through a copy of the shared devbox base profile `~/.devbox/browser/edge-base` (override with `EDGE_BASE_PROFILE`). Sign in to that profile with `devbox browser profile open` and close Edge. The first run clones it with `cp -cR` into `~/.ticket-scraper/edge-profile` (override with `EDGE_PROFILE`). Later runs reuse the copy, so a later sign-in to the base only reaches the scraper after you delete the copy. Playwright attaches to that Edge over CDP on loopback. On exit the scraper closes Edge through CDP so the profile gets saved.

The agent calls the `AZURE_OPENAI_DEPLOYMENT` (default `gpt-5.1`) on Azure AI Foundry as the signed-in `az` CLI user, so run `az login` first.

Secrets the agent may type into pages come from `SECRET_<NAME>` variables, for example in a gitignored `.env`. Pin each one to the sites it belongs on with `SECRET_<NAME>_ORIGINS=https://example.com`; an unpinned secret can be entered on any page, including one that asks for it in its text.

This project was created using `bun init` in bun v1.4.2. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

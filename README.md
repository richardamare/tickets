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
bun run start restock <event-url> [--quantity 1] [--every 10] [--cart-refreshes 2]
bun run start seats <event-url> [--json]
bun run start profile <name>
```

`watch` has the agent read each event page's availability, every 15 minutes (at least 5), and prints plus notifies on every change. A page behind a bot check, captcha or waiting room is reported as a failed check, never as sold out; `--once` exits non-zero when any check fails. With `--until <status>` (`on_sale`, `sold_out`, `not_yet_on_sale` or `resale_only`, repeatable), each page is polled until its status is one of those, notified, and dropped; `watch` exits once every page has reached one. Results are kept in `~/.ticket-scraper/watch.json` (override with `WATCH_STATE_FILE`).

`restock` watches one Fnac Spectacles event and puts tickets in the cart the moment any are free. It polls Eventim's seat map API over plain HTTP every 10 seconds (at least 5, with jitter), which answers in well under a kilobyte and counts free seats and standing places per price category. A sold-out event has no seat map to serve, so for those it fetches the event page from inside the open tab instead. Edge stays open in the background on the event page, so on a hit it reloads the page, takes the category with the most free tickets from the ticket list beside the seat map, sets the quantity to `--quantity` or as many as are left, and adds them to the cart. A cart that shows no tickets within 5 seconds is refreshed up to `--cart-refreshes` times (2 by default) before the next category is tried. It then stops polling and sends a notification; clicking it brings that Edge to the front on the cart, where the tickets are held for about 15 minutes. Pay there and close the window to end the command — stopping the command closes Edge and drops the cart. The clickable notification needs `terminal-notifier` (`brew install terminal-notifier`). Homebrew installs it outside `/Applications`, so register it once with `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f $(brew --prefix terminal-notifier)/terminal-notifier.app` and send one notification to get the permission prompt; without it Edge comes to the front straight away with a sound.

`seats` picks the seat provider for the URL's site, opens the event's seating chart and lists the free seats: a count per price category and per row, or every seat with `--json`. Providers live in `src/providers/` and implement `SeatProvider` from `src/seats.ts`; add one to `providers` there to support another site. The only one so far reads Fnac Spectacles through the Eventim seat map API behind its seating chart. `position` is the seat's order within its row on the map, not the number printed on the ticket.

Pages open in Microsoft Edge from `/Applications`, signed in through a copy of the shared devbox base profile `~/.devbox/browser/edge-base` (override with `EDGE_BASE_PROFILE`). Sign in to that profile with `devbox browser profile open` and close Edge. The first run clones it with `cp -cR` into `~/.ticket-scraper/edge-profile` (override with `EDGE_PROFILE`). Later runs reuse the copy, so a later sign-in to the base only reaches the scraper after you delete the copy. Playwright attaches to that Edge over CDP on loopback. On exit the scraper closes Edge through CDP so the profile gets saved.

For several accounts, keep one saved profile per account. `profile <name>` opens a visible Edge on `~/.ticket-scraper/profiles/<name>`, empty the first time; sign in to every site that account needs and close the window, and the scraper closes Edge so the profile gets saved. Run it again on the same name to refresh an expired sign-in. Add `--profile <name>` to any other command to run as that account instead of the base profile copy.

The agent calls the `AZURE_OPENAI_DEPLOYMENT` (default `gpt-5.4`, reasoning effort `AZURE_OPENAI_REASONING_EFFORT`, default `low`) on Azure AI Foundry as the signed-in `az` CLI user, so run `az login` first.

Secrets the agent may type into pages come from `SECRET_<NAME>` variables, for example in a gitignored `.env`. Pin each one to the sites it belongs on with `SECRET_<NAME>_ORIGINS=https://example.com`; an unpinned secret can be entered on any page, including one that asks for it in its text.

This project was created using `bun init` in bun v1.4.2. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

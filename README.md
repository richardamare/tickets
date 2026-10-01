# ticket-scraper

Setting up a new Mac to run this: follow [SETUP.md](SETUP.md).

Install it as the global `tickets` command with `bun install -g github:richardamare/tickets`, or from a clone with `bun link`. `tickets` runs the same as `bun run start`.

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run start
bun run start tui
bun run start title <url>
bun run start agent "<task>"
bun run start watch <event-url>... [--every 0.5] [--once] [--until on_sale]...
bun run start restock <event-url> [--quantity 1] [--prefer cheapest|most-free] [--every 0.5] [--cart-refreshes 2]
bun run start seats <event-url> [--json]
bun run start profile <name> [--browser chrome|edge]
```

`start` without a subcommand (or `start tui`) opens the live terminal dashboard. Start with `/setup`: choose Chrome (the default) or Edge, name a reusable source profile, sign in, then **close the setup browser window** to save it. Setup runs independently of the UI. Type `/` in the bottom prompt to choose a command, or type `/watch` or `/restock` directly. The guided setup asks for the event link, check frequency and browser account; restock also asks how many tickets to reserve, and watch asks when to stop. Press Enter to accept a suggested value. Review the summary and press Enter on **Start**. You can also paste the URL after the command, such as `/watch https://example.com/event`.

Listeners started from the dashboard run as independent background processes. Closing the UI, closing its terminal window or reopening the dashboard leaves them running. Use `/stop` on a selected listener to stop it explicitly; confirmation explains that this closes its browser window. The dashboard confirms completion only after the listener acknowledges resource teardown; an offline row alone does not confirm a stop. Stopping one event from a multi-event CLI watch stops that entire watch run. Background operation lasts for the current OS session; it does not restart listeners after a reboot or keep checks running while the computer sleeps.

The dashboard shows every `watch` and `restock` event started by this version, including commands running in other terminals: availability, profile, last check, next check and up to four recent status messages in the expanded row. Each listener retains its latest 30 messages on disk. Existing processes started before this version need a restart to gain the new controls. Commands you start manually in another terminal remain owned by that terminal.

| Key | Action |
| --- | --- |
| `/setup` | Choose Chrome or Edge and prepare a saved sign-in profile |
| `/watch`, `/restock` | Start guided listener setup |
| `↑` / `↓` | Select a listener, slash command or browser account |
| `→` | Bring the selected listener's browser to the front (a live restock listener, such as one in cart) |
| `?` | Show every shortcut; `?` or `Esc` closes the list |
| `Enter` | Submit the prompt; expand listener details when the prompt is empty |
| `Tab` | Complete the selected slash command |
| `Ctrl+B`, `Esc` | Go back one setup question; cancel setup |
| `/filter`, `/active` | Search listeners; toggle active listeners / all history |
| `/stop` | Stop the selected listener after confirmation |
| `Ctrl+X` | Stop the selected listener at once; press again within 1.5 s to archive it. A listener holding a cart asks first |
| `Home` / `End`, `PgUp` / `PgDn` | Jump to first / last or move ten listeners with an empty prompt |
| `/help` | Show shortcuts |
| `/quit`, `Ctrl+C` | Close the UI; background listeners keep running |

Choose a saved source profile with the arrow keys, or press Enter for the saved default. Profiles are reusable: each run receives its own browser data directory. Close the source setup window before starting listeners. Separate directories do not create separate site accounts; runs copied from one signed-in source may share a server-side cart. Use `/setup` again to refresh an expired sign-in or change the default browser and profile.

The dashboard needs an interactive terminal. Listener snapshots live in `~/.ticket-scraper/listeners` (override with `TICKET_LISTENERS_DIR` in both the dashboard and listeners). Each process publishes a heartbeat every 5 seconds; after 20 seconds without one, the row is marked offline. Completed and stopped runs remain visible until archived; an archived listener is hidden from every view, and its record stays on disk beside a `<id>.archived` marker. `In cart` means the restock command confirmed tickets and is waiting for you to pay in the selected browser; it does not extend or recheck the cart hold. Registry write failures warn once and leave ticket monitoring running.

`--every` is in seconds for both commands and accepts decimals, with a minimum of 0.5. Watch previously used minutes; convert existing CLI invocations to seconds. Checks run sequentially: time spent checking counts toward the interval; a slow check delays the next start without overlapping requests. Existing running listeners retain their launch interval until restarted.

`watch` reads each Fnac Spectacles event's availability from the same seat map API as `restock`, in about 100 ms and without opening a browser, with no prices and an event that serves no seat map reported as `sold_out`. It accepts only Fnac Spectacles event pages, checks on a 0.5-second schedule by default, and prints plus notifies on every change. A page behind a bot check, captcha or waiting room is reported as a failed check, never as sold out; `--once` exits non-zero when any check fails. With `--until <status>` (`on_sale`, `sold_out`, `not_yet_on_sale` or `resale_only`, repeatable), each page is polled until its status is one of those, notified, and dropped; `watch` exits once every page has reached one. Results are stored atomically per event, browser and profile under `~/.ticket-scraper/watch.json.d` (set `WATCH_STATE_FILE` to change the base path). Existing `watch.json` is read only for legacy Edge/default migration. Concurrent listeners do not overwrite one another’s event history.

`restock` watches one Fnac Spectacles event and puts tickets in the cart the moment any are free. It polls Eventim's seat map API over plain HTTP every 0.5 seconds by default, without jitter, which answers in well under a kilobyte and counts free seats and standing places per price category. A 403 from the API, or a 403 or Akamai "Access Denied" page in the browser, marks the listener **Blocked** in the dashboard and sends one notification; it stays Blocked until a cart attempt gets through, and a blocked cart attempt is not retried on another category. An event with a seat map is checked over the API alone. An event that serves no seat map, because it is sold out or sold without one, is checked on its event page instead, fetched from inside the open tab so it carries the browser's bot-check cookies; it counts as on sale once the page shows a cart button. The seat map only tells what is free; tickets are never bought by picking seats. The selected browser stays open in the background on the event page, so on a hit it reloads the page, takes the cheapest category from the ticket list beside the seat map or from the fast booking widget that some events show instead (`--prefer most-free` takes the one with the most free tickets instead), sets the quantity to `--quantity` or as many as the site allows in one order, and adds them to the cart. When the site caps an order below `--quantity`, each further cart goes into another browser on a fresh copy of the profile, started without Fnac's cookies so it holds a cart of its own, until the whole quantity is reserved; every cart is announced the moment it fills, since each hold expires on its own. The first browser stays signed in; the others sign in at checkout. A cart that shows no tickets within 5 seconds is refreshed up to `--cart-refreshes` times (2 by default) before the next category is tried. It then stops polling and sends a notification; clicking it brings that browser to the front on the cart, where the tickets are held for about 15 minutes. Pay there and close the window to end the command — stopping the command closes the browser; site cart holds can expire. The clickable notification needs `terminal-notifier` (`brew install terminal-notifier`). Homebrew installs it outside `/Applications`, so register it once with `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f $(brew --prefix terminal-notifier)/terminal-notifier.app` and send one notification to get the permission prompt; without it the browser comes to the front straight away with a sound.

`seats` picks the seat provider for the URL's site, opens the event's seating chart and lists the free seats: a count per price category and per row, or every seat with `--json`. Providers live in `src/providers/` and implement `SeatProvider` from `src/seats.ts`; add one to `providers` there to support another site. The only one so far reads Fnac Spectacles through the Eventim seat map API behind its seating chart. `position` is the seat's order within its row on the map, not the number printed on the ticket.

Pages open in Chrome by default, or Edge when selected with `/setup` or `--browser edge`. Both browsers are loaded from `/Applications`. The saved selection applies to CLI commands too; `--browser` and `--profile` override it. Every command clones a closed source into a temporary run directory, attaches through Playwright over loopback CDP, and removes the clone after closing the browser. Sign-in changes made inside a run are not copied back to the source.

Browser settings and source profiles live under `~/.ticket-scraper/browsers` (override with `TICKET_BROWSER_HOME`). `profile <name> --browser chrome` opens that source for human sign-in and saves the default only after its window closes. Sources are locked during setup and copying; opening setup while a source is already open fails explicitly. Existing closed Edge profiles under `~/.ticket-scraper/profiles` and `~/.ticket-scraper/edge-profile` remain available for migration. Profile data contains credentials; keep these directories private.

The agent calls the `AZURE_OPENAI_DEPLOYMENT` (default `gpt-5.4`, reasoning effort `AZURE_OPENAI_REASONING_EFFORT`, default `low`) on Azure AI Foundry as the signed-in `az` CLI user, so run `az login` first.

Secrets the agent may type into pages come from `SECRET_<NAME>` variables, for example in a gitignored `.env`. Pin each one to the sites it belongs on with `SECRET_<NAME>_ORIGINS=https://example.com`; an unpinned secret can be entered on any page, including one that asks for it in its text.

This project was created using `bun init` in bun v1.4.2. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

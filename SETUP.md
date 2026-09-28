# Set up a new MacBook

This takes about 20 minutes on a clean Mac, most of it waiting for downloads. Paste each command into **Terminal** (press `⌘ Space`, type `Terminal`, press Enter), one block at a time, and wait for it to finish before pasting the next.

## 1. Install Apple's developer tools

```bash
xcode-select --install
```

Click **Install** in the window that opens and wait until it says the software was installed. This gives you `git`.

## 2. Install Homebrew

Homebrew installs everything else.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

It asks for your Mac password. Nothing appears as you type it, which is normal. When it finishes, make `brew` available in every new Terminal window:

```bash
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile && eval "$(/opt/homebrew/bin/brew shellenv)"
```

Check it works: `brew --version` prints a version number.

## 3. Install Bun, a browser and the notifier

```bash
brew install oven-sh/bun/bun terminal-notifier
brew install --cask google-chrome
```

Use Microsoft Edge instead of Chrome if you prefer it: `brew install --cask microsoft-edge`. The browser must end up in `/Applications`, which is where these commands put it.

## 4. Allow notifications

The app tells you tickets are in the cart through a notification you click. Register the notifier once and send a test notification:

```bash
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$(brew --prefix terminal-notifier)/terminal-notifier.app"
terminal-notifier -title "Tickets" -message "Notifications work"
```

When macOS asks, click **Allow**. If no notification shows, open **System Settings → Notifications → terminal-notifier** and turn on **Allow notifications**.

## 5. Install the app

```bash
bun install -g github:richardamare/tickets
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zprofile && export PATH="$HOME/.bun/bin:$PATH"
```

This installs the `tickets` command, which works from any folder. Check it: `tickets --help` prints the commands.

## 6. Sign in once

```bash
tickets
```

The dashboard opens.

1. Type `/setup` and press Enter.
2. Press Enter to keep Chrome, or type `2` for Edge.
3. Type a name for the account, such as `me`, and press Enter.
4. A browser window opens. Go to [fnacspectacles.com](https://www.fnacspectacles.com), sign in, and decline the cookies.
5. **Close that browser window.** Closing it is what saves the sign-in.

## 7. Reserve tickets

In the dashboard:

1. Type `/restock` and press Enter.
2. Paste the Fnac Spectacles event link, such as `https://www.fnacspectacles.com/event/…-22002879/`, and press Enter.
3. Press Enter to accept each suggested value, or type your own: how many tickets, and whether to take the **cheapest** first (the default) or the category with the **most free tickets**.
4. Press Enter on **Start**.

The listener checks every half second. When tickets appear, it puts them in the cart and sends a notification. Click it and **pay within about 15 minutes**. The app never pays for you.

The site limits how many tickets one order takes, often 4 to 6. Ask for more, and the app opens **another browser window for each further cart**, each with its own notification and its own 15 minutes. Pay in each window; the extra windows ask you to sign in at checkout.

The first time the app brings the browser to the front, macOS asks whether Terminal may control **System Events**. Click **OK**.

## Keep it running

- **Closing the dashboard is fine.** Listeners keep running in the background. Run `tickets` again to see them.
- **Keep the Mac awake.** A sleeping Mac checks nothing. Keep it plugged in with the lid open, and run this in a spare Terminal window while you wait:

  ```bash
  caffeinate -dims
  ```

- **Stopping a restock listener closes its browser, and the cart with it.** Stop one only when you no longer need its tickets.

## Shortcuts

Press `?` in the dashboard for the full list. The ones you need most:

| Key | Does |
| --- | --- |
| `↑` / `↓` | Select a listener |
| `→` | Bring that listener's browser to the front, to pay |
| `Ctrl+X` | Stop the selected listener; press it twice to also hide it |
| `Ctrl+C` | Close the dashboard; listeners keep running |

## When something goes wrong

| You see | Do |
| --- | --- |
| **Blocked** next to a listener | The site refused the browser (HTTP 403). Stop the listener with `Ctrl+X`, wait 30 minutes, and start it again. |
| `command not found: bun` or `brew` | Close Terminal, open a new window, and try again. If it persists, repeat step 2 or 3. |
| The browser does not open, or the setup says the profile is not ready | Run `/setup` again and make sure you **close** the browser window at the end. |
| No notification when tickets are in the cart | Repeat step 4. The browser still comes to the front with a sound. |

## Update to the latest version

```bash
bun install -g github:richardamare/tickets
```

Stop your running listeners with `Ctrl+X` and start them again, so they use the new version.

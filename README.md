# Envelopes

A simple envelope budgeting app: a personal replacement for [Goodbudget](https://goodbudget.com), built to keep what made it good (envelopes, a monthly fill, quick expense entry) and nothing else.

**Live app:** https://vaiseys.github.io/envelopes/

- **Envelopes** are grouped as *Monthly* (refilled each month to a budget) or *Goal* (saving toward a target). Progress bars and a tick mark show how far through the month you are.
- **Transactions:** expenses, income, and moving money between envelopes. **Fill envelopes** hands out your *[Available]* money each month: each monthly envelope can *top up* to its budget (returning any surplus to *[Available]*) or *add* its budget on top (keeping the surplus), and whatever's left can be swept into one envelope.
- **Accounts** (checking, cash, cards) track where the money is. Envelopes track what it's for, and the two totals always match.
- **Works offline** and installs on Android like a regular app. There's no app store and no bank connection.
- **Optional sync to a Google Sheet you own.** That backs up your budget, lets several devices share it, and gives you a spreadsheet to sort and chart.

It's plain HTML, CSS and JavaScript, with no build step and no dependencies.

---

## Install on Android

1. Open **Chrome** and go to https://vaiseys.github.io/envelopes/.
2. Tap Chrome's **⋮** menu, then **Install app** (or **Add to Home screen**).
3. Open **Envelopes** from your home screen.

A new install starts with demo data so you can try it out. You can erase it when you connect sync, or from **⋮ → Start fresh**.

To use light mode even when the phone is in dark mode, go to **⋮ → Appearance → Light**. This setting is saved separately on each device.

---

## Set up Google Sheets sync

This takes about 10 minutes, once. After that, every device connects with just a URL and a key.

### 1. Create the sheet
Go to [sheets.new](https://sheets.new) and name it something like **Budget**.

### 2. Add the script
1. In the sheet, choose **Extensions → Apps Script**. The editor opens in a new tab.
2. Delete the placeholder code, then paste in all of [`sheets-sync/Code.gs`](sheets-sync/Code.gs).
3. In the app, tap the sync status line at the top (or **⋮ → Google Sheets sync**), then tap **Copy** next to the sync key.
4. In the script, replace `PASTE-YOUR-SYNC-KEY-HERE` on the `SECRET_KEY` line with your key. Keep the quotes.
5. Click the 💾 save icon.

> The script must be created from inside the sheet (Extensions → Apps Script). A project started directly at script.google.com isn't attached to a sheet, and syncing will fail.

### 3. Deploy it as a web app
The **Deploy** button is the blue button in the **top-right corner of the Apps Script tab**, next to Run and Debug. It isn't in the Google Sheet itself. If you can't see it, widen the window or zoom out.

1. Click **Deploy ▾ → New deployment**.
2. Click the small ⚙️ gear next to **Select type** (top left of the dialog) and choose **Web app**. The large gear in the middle is just a picture.
3. Set **Execute as: Me** and **Who has access: Anyone**. Don't choose "Anyone with Google account".
4. Click **Deploy**, then **Authorize access** and pick your Google account.
   - Google warns that it "hasn't verified this app." That's expected, because it's your own script. Click **Advanced → Go to (project name) (unsafe) → Allow**.
5. Copy the **Web app URL**. It ends in `/exec`.

### 4. Connect the app
Paste the URL into the app's sync screen and tap **Connect**. Within a few seconds the sheet gets **Envelopes**, **Accounts** and **Transactions** tabs.

### Adding another device
On the new device, open the app, tap the sync status line, and enter the **same URL and sync key**. When it asks whether to erase the demo data, say yes. The device then copies the budget down from the sheet.

### Updating the script later
If `Code.gs` changes, update the copy in Apps Script without changing its URL:

1. Copy your `SECRET_KEY` line, paste in the new code, and put your line back.
2. Click **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**.

Don't use **New deployment** for this. It creates a new URL, which you'd have to enter on every device again.

---

## How sync works

- **Each device keeps its own copy** and works offline. A few seconds after each change, and whenever the app opens, it sends its changes to the sheet and receives everyone else's. If the same item was changed in two places, the most recent change wins.
- **The sheet is a copy for reading, sorting and charting.** Make changes in the app, because edits typed directly into the sheet may be overwritten.
- **Deleted transactions** stay in the sheet for 30 days (marked **Deleted = TRUE**, with a blank amount) so other devices can learn about the deletion. Then they're removed automatically. Archived envelopes and accounts are removed too, once no remaining transaction uses them. To change the wait, edit `PURGE_AFTER_DAYS` in `Code.gs`. A device that hasn't synced for more than 30 days may still show a transaction deleted elsewhere. If so, delete it there too.

### Privacy
- This repository contains **no budget data and no keys**. Your data lives in the app on each device and in your own Google Sheet.
- **Treat the web app URL and sync key like a password.** Anyone with both could read and change your budget.

---

## What's in this repo

| Path | What it is |
| --- | --- |
| `index.html` | The page that loads the app |
| `app.js` | All app logic: envelopes, transactions, fills, sync, settings |
| `styles.css` | Look and feel, including light and dark themes |
| `sw.js` | Service worker that makes the app work offline |
| `manifest.webmanifest`, `icon*` | What makes it installable, plus its icons |
| `sheets-sync/Code.gs` | The Google Apps Script that runs inside your sheet |

**Run it locally:** from this folder, run `python3 -m http.server 8123` and open http://localhost:8123.

**Publish a change:** commit and push to `main`. GitHub Pages updates the live site within a minute or two, and installed apps pick up the change the next time they're opened online. If you add or rename app files, also update the file list and bump `CACHE` in `sw.js`.

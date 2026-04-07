# Announce Bot — Setup Guide

Tracked Slack broadcasts. Send a message to a group, everyone gets a DM with a "✅ Mark as Read" button. You see who's read it and can nudge the slackers.

---

## What You Get

- `/announce` — compose a message, pick a group, hit send
- `/announce-status` — see a live read/unread dashboard with progress bar
- `/groups` — create custom named groups (e.g. "UK Sales", "EMEA AEs")
- Auto-detects Slack User Groups and channels as audiences
- "Nudge" button to re-ping everyone who hasn't read yet
- Real-time DM to you when each person clicks ✅

---

## Step 1: Create the Slack App

Go to **https://api.slack.com/apps** → **Create New App** → **From scratch**

- **App Name**: `Announce Bot` (or whatever you want)
- **Workspace**: your workspace

---

## Step 2: Enable Socket Mode

In the left nav: **Socket Mode** → Enable Socket Mode

Then: **Basic Information** → **App-Level Tokens** → **Generate Token**
- Token Name: `socket-token`
- Scope: `connections:write`
- Copy the token (starts with `xapp-`) → this is your `SLACK_APP_TOKEN`

---

## Step 3: Add OAuth Scopes

**OAuth & Permissions** → **Bot Token Scopes** → Add:

| Scope | Why |
|-------|-----|
| `chat:write` | Send DMs and channel messages |
| `commands` | Register slash commands |
| `users:read` | Look up user names |
| `im:write` | Open DM channels |
| `channels:read` | List public channels |
| `groups:read` | List private channels |
| `conversations.members:read` | Get channel members |
| `usergroups:read` | List Slack User Groups *(optional but recommended)* |
| `usergroups.users:read` | Get User Group members *(optional but recommended)* |

---

## Step 4: Create Slash Commands

**Slash Commands** → **Create New Command** (repeat for each):

| Command | Description | Usage Hint |
|---------|-------------|------------|
| `/announce` | Send a tracked announcement | — |
| `/announce-status` | Check read receipts | `[announcement-id]` |
| `/groups` | Manage recipient groups | `create \| delete \| list` |

> **Request URL**: Leave blank for now — Socket Mode doesn't need it.

---

## Step 5: Enable Interactivity

**Interactivity & Shortcuts** → Enable **Interactivity**

> Request URL: not needed in Socket Mode — leave blank or put any valid URL.

---

## Step 6: Install the App

**OAuth & Permissions** → **Install to Workspace** → Authorise

Copy the **Bot User OAuth Token** (starts with `xoxb-`)

---

## Step 7: Set Up Your .env

```bash
cd announce-bot
cp .env.example .env
```

Then edit `.env`:

```
SLACK_BOT_TOKEN=xoxb-your-token-here
SLACK_SIGNING_SECRET=your-signing-secret-here   # Basic Information → Signing Secret
SLACK_APP_TOKEN=xapp-your-app-token-here
```

---

## Step 8: Run It

```bash
cd announce-bot
npm install
npm start
```

You should see:
```
✅ Announce Bot is running!
   Slack Socket Mode: enabled
```

---

## Usage

### Send an Announcement

Type `/announce` in any Slack channel → a modal opens:
1. Write your message
2. Pick your audience (Slack User Group, custom group, or channel)
3. Optionally also post in a channel
4. Hit **Send**

Everyone in the group gets a DM with a ✅ button. You get a confirmation with a link to track responses.

### Check Read Receipts

- `/announce-status` → see all your recent announcements with % read
- Click **📊 Details** on any one to see exactly who's read and who hasn't
- Hit **👋 Nudge Unread People** to re-ping slackers

### Manage Custom Groups

- `/groups create` → opens a modal to name your group and pick members
- `/groups` → list all custom groups
- `/groups delete <id>` → remove a group

> **Tip**: Custom groups supplement Slack User Groups. If your workspace has User Groups set up, they'll automatically appear in the `/announce` audience picker.

---

## Troubleshooting

**"No groups found"** — Add the `usergroups:read` and `usergroups.users:read` scopes, or use `/groups create` to make a custom group.

**"Could not DM user"** — The bot might not have permission to DM that person. Make sure `im:write` scope is added and the app is reinstalled.

**"Socket Mode not enabled"** — Check that `SLACK_APP_TOKEN` is set in your `.env`.

**Bolt version error** — Run `npm install` inside the `announce-bot/` folder.

---

## Tech Stack

- **Node.js** — no TypeScript build step needed, just `node index.js`
- **Bolt.js** — official Slack framework
- **sql.js** — SQLite in pure JS (no native DB installation needed)
- Data persists to `announce-bot.db` in the same folder

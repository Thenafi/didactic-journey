# Hostbuddy Slack Integration

A Cloudflare Worker that integrates Hostbuddy webhooks with Slack channels, allowing action items to be posted with resolution buttons.

## Features

- Receives Hostbuddy webhook notifications
- Posts action items to Slack with "Resolved" buttons
- Handles multiple action items with delays to avoid rate limiting
- Removes resolved items from the main channel
- Posts resolution notifications to a separate channel

## Setup

### 1. Prerequisites

- Cloudflare account
- Slack workspace with bot permissions
- Node.js installed locally

### 2. Slack App Setup

1. Create a new Slack app at https://api.slack.com/apps
2. Enable the following OAuth scopes:
   - `chat:write`
   - `chat:write.public`
   - `commands`
   - `channels:read`
3. Enable Interactive Components and set the Request URL to: `https://your-worker.your-subdomain.workers.dev/slack/interactive`
4. Install the app to your workspace and note the Bot User OAuth Token

### 3. Environment Configuration

1. Install Wrangler CLI:

   ```bash
   npm install -g wrangler
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Set up secrets:

   ```bash
   wrangler secret put SLACK_BOT_TOKEN
   wrangler secret put WEBHOOK_SECRET
   ```

4. Update `wrangler.toml` with your channel IDs:
   - `SLACK_CHANNEL_ID`: The channel where action items will be posted
   - `SLACK_RESOLVED_CHANNEL_ID`: The channel where resolution notifications will be posted

### 4. Deploy

```bash
npm run deploy
```

### 5. Configure Hostbuddy Webhook

Set your Hostbuddy webhook URL to: `https://your-worker.your-subdomain.workers.dev/webhook`

## Usage

1. When Hostbuddy sends a webhook with action items, they will be posted to your configured Slack channel
2. Each action item will have a "Resolved" button
3. Clicking the button will:
   - Remove the message from the main channel
   - Post a resolution notification to the resolved channel
   - Include information about who resolved the item

## Development

Run locally for testing:

```bash
npm run dev
```

## Webhook Payload

The worker expects webhook payloads in this format:

```json
{
  "action_items": [
    {
      "user_id": "castlehost99_gmail_com",
      "property_name": "Paramount 3911 |A033_Aurora",
      "guest_name": "Faisal null",
      "item": "HostBuddy has stopped responding to this guest because their sentiment turned negative.",
      "category": "OTHER",
      "created_at_utc": "2025-08-25T05:59:27Z",
      "id": "8060b15cda4c",
      "status": "incomplete",
      "reservation_id": "c17f36a2-9327-4bf6-87df-1317e0a4df0d",
      "conversation_id": "c17f36a2-9327-4bf6-87df-1317e0a4df0d",
      "hospitable_reservation_id": "c17f36a2-9327-4bf6-87df-1317e0a4df0d"
    }
  ],
  "hook_id": "5aa4c04e-d8e7-4a99-86d1-9a683e661a6e"
}
```

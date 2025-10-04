export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle webhook endpoint
    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleHostbuddyWebhook(request, env);
    }

    // Handle Slack interactive components (button clicks)
    if (url.pathname === "/slack/interactive" && request.method === "POST") {
      return handleSlackInteraction(request, env, ctx);
    }

    // Default response
    return new Response("Hostbuddy Slack Integration Worker", { status: 200 });
  },
};

async function handleHostbuddyWebhook(request, env) {
  try {
    const payload = await request.json();

    // Process action items
    if (payload.action_items && Array.isArray(payload.action_items)) {
      await processActionItems(payload.action_items, env);
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("Error processing webhook:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

async function processActionItems(actionItems, env) {
  for (let i = 0; i < actionItems.length; i++) {
    const item = actionItems[i];
    console.log("Processing action item:", item);

    try {
      await sendSlackMessage(item, env);

      // Add delay between messages to avoid rate limiting
      if (i < actionItems.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error(`Error processing action item ${item.id}:`, error);
    }
  }
}

async function sendSlackMessage(actionItem, env) {
  // Check if this is an ARRIVAL-DEPARTURE item for property A044
  const isArrivalDepartureA044 =
    actionItem.category === "ARRIVAL-DEPARTURE" &&
    actionItem.property_name &&
    actionItem.property_name.includes("A044");

  if (isArrivalDepartureA044) {
    // Send to special channel without resolve button
    await sendArrivalDepartureA044Message(actionItem, env);
  }

  // Send to regular channel with resolve button (for all items)
  const message = {
    channel: env.SLACK_CHANNEL_ID,
    text: `New action item for ${actionItem.guest_name || "N/A"}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*🏠 Property:* ${
            actionItem.property_name || "N/A"
          }\n*👤 Guest:* ${
            actionItem.guest_name || "N/A"
          }\n*📝 Description:* ${(actionItem.item || "N/A").replace(
            /\n/g,
            " "
          )}\n*🏷️ Category:* ${actionItem.category || "N/A"}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Resolved",
              emoji: true,
            },
            style: "primary",
            action_id: "resolve_action_item",
            value: JSON.stringify({
              item_id: actionItem.id,
              property_name: actionItem.property_name,
              guest_name: actionItem.guest_name,
              reservation_id: actionItem.reservation_id,
              item: actionItem.item,
              category: actionItem.category,
            }),
          },
        ],
      },
    ],
  };

  console.log("Sending Slack message:", message);
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Slack API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

async function sendArrivalDepartureA044Message(actionItem, env) {
  const message = {
    channel: "C07U1GHS1R9",
    text: `Hi <@U081UEASH37> <@U07UY3M1TF0> - New arrival/departure action item for ${
      actionItem.guest_name || "N/A"
    }`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Hi <@U081UEASH37> <@U07UY3M1TF0>\n\n*🏠 Property:* ${
            actionItem.property_name || "N/A"
          }\n*👤 Guest:* ${
            actionItem.guest_name || "N/A"
          }\n*📝 Description:* ${(actionItem.item || "N/A").replace(
            /\n/g,
            " "
          )}\n*🏷️ Category:* ${actionItem.category || "N/A"}`,
        },
      },
    ],
  };

  console.log("Sending ARRIVAL-DEPARTURE A044 Slack message:", message);
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      `Error sending ARRIVAL-DEPARTURE A044 message: ${response.status} - ${errorText}`
    );
  }

  return response.json();
}

async function handleSlackInteraction(request, env, ctx) {
  try {
    const formData = await request.formData();
    const payload = JSON.parse(formData.get("payload"));

    if (
      payload.type === "block_actions" &&
      payload.actions[0].action_id === "resolve_action_item"
    ) {
      const action = payload.actions[0];
      const actionData = JSON.parse(action.value);
      const user = payload.user;
      const channelId = payload.channel.id;
      const messageTs = payload.message.ts;

      // Respond to Slack immediately
      ctx.waitUntil(
        (async () => {
          // Delete the original message
          await deleteSlackMessage(channelId, messageTs, env);

          // Post resolution message to the resolved channel
          await postResolutionMessage(actionData, user, env);

          // Send an ephemeral message to the original channel
          await sendEphemeralConfirmation(channelId, user, env);
        })()
      );

      return new Response(null, { status: 200 });
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("Error handling Slack interaction:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

async function deleteSlackMessage(channel, timestamp, env) {
  const response = await fetch("https://slack.com/api/chat.delete", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel: channel,
      ts: timestamp,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      `Error deleting Slack message: ${response.status} - ${errorText}`
    );
  }
}

async function postResolutionMessage(actionData, user, env) {
  const message = {
    channel: env.SLACK_RESOLVED_CHANNEL_ID,
    text: `Action item resolved by ${user.name}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `✅ *Action Item Resolved by ${user.name}*\n\n*Property:* ${
            actionData.property_name || "N/A"
          }\n*Guest:* ${actionData.guest_name || "N/A"}\n*Description:* ${
            actionData.item || "N/A"
          }\n*Category:* ${actionData.category || "N/A"}\n*Item ID:* ${
            actionData.item_id
          }`,
        },
      },
    ],
  };

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      `Error posting resolution message: ${response.status} - ${errorText}`
    );
  }
}

async function sendEphemeralConfirmation(channelId, user, env) {
  const message = {
    channel: channelId,
    user: user.id,
    text:
      `An action item was marked as resolved by ${user.name}. The action item you just resolved is logged in #data-channel so you can check there when necessary.\n` +
      `If you accidentally resolved something, that's a great place to bring it back.`,
  };

  await fetch("https://slack.com/api/chat.postEphemeral", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });
}

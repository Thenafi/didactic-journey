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
      // Fetch reservation data if hospitable_reservation_id is available
      let reservationData = null;
      if (item.hospitable_reservation_id) {
        reservationData = await fetchReservationData(
          item.hospitable_reservation_id,
          env
        );
      }

      await sendSlackMessage(item, reservationData, env);

      // Add delay between messages to avoid rate limiting
      if (i < actionItems.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error(`Error processing action item ${item.id}:`, error);
    }
  }
}

async function fetchReservationData(reservationId, env) {
  try {
    const url = `https://public.api.hospitable.com/v2/reservations/${reservationId}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${env.HOSPITABLE_API_TOKEN}`,
      },
    });

    if (!response.ok) {
      console.error(`Error fetching reservation data: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return data.data;
  } catch (error) {
    console.error("Error fetching reservation data:", error);
    return null;
  }
}

async function sendSlackMessage(actionItem, reservationData, env) {
  // Check if this is an ARRIVAL-DEPARTURE item for property A044
  const isArrivalDepartureA044 =
    actionItem.category === "ARRIVAL-DEPARTURE" &&
    actionItem.property_name &&
    actionItem.property_name.includes("A044");

  if (isArrivalDepartureA044) {
    // Send to special channel without resolve button
    await sendArrivalDepartureA044Message(actionItem, reservationData, env);
  }

  // Check if sentiment turned negative
  const isSentimentNegative =
    actionItem.item &&
    actionItem.item.toLowerCase().includes("sentiment turned negative");

  if (isSentimentNegative) {
    if (reservationData && reservationData.check_out) {
      // Schedule a reminder message at checkout time
      await scheduleNegativeSentimentReminder(actionItem, reservationData, env);
    } else {
      // Failsafe: mention user if no reservation data
      await sendNegativeSentimentFailsafe(actionItem, env);
    }
  }

  // Format check-in and check-out dates as human-readable local time with offset, no conversion
  function formatWithOffset(isoString) {
    if (!isoString) return "N/A";
    const d = new Date(isoString);
    const match = isoString.match(/([+-]\d{2}:\d{2})$/);
    const offset = match ? `UTC${match[1]}` : "";
    return (
      d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }) + (offset ? ` (${offset})` : "")
    );
  }
  let dateInfo = "";
  let hospitableLink = "";
  if (reservationData) {
    const checkIn = formatWithOffset(reservationData.check_in);
    const checkOut = formatWithOffset(reservationData.check_out);
    dateInfo = `\n*:date: Stay:* ${checkIn} ---> ${checkOut}`;
    if (reservationData.conversation_id) {
      hospitableLink = `\n<https://my.hospitable.com/inbox/thread/${reservationData.conversation_id}|View in Hospitable>`;
    }
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
          }${dateInfo}\n*📝 Description:* ${(actionItem.item || "N/A").replace(
            /\n/g,
            " "
          )}\n*🏷️ Category:* ${actionItem.category || "N/A"}${hospitableLink}`,
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

async function sendArrivalDepartureA044Message(
  actionItem,
  reservationData,
  env
) {
  // Format check-in and check-out dates as human-readable local time with offset, no conversion
  function formatWithOffset(isoString) {
    if (!isoString) return "N/A";
    const d = new Date(isoString);
    const match = isoString.match(/([+-]\d{2}:\d{2})$/);
    const offset = match ? `UTC${match[1]}` : "";
    return (
      d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }) + (offset ? ` (${offset})` : "")
    );
  }
  let dateInfo = "";
  let hospitableLink = "";
  if (reservationData) {
    const checkIn = formatWithOffset(reservationData.check_in);
    const checkOut = formatWithOffset(reservationData.check_out);
    dateInfo = `\n*:date: Stay:* ${checkIn} ---> ${checkOut}`;
    if (reservationData.conversation_id) {
      hospitableLink = `\n<https://my.hospitable.com/inbox/thread/${reservationData.conversation_id}|View in Hospitable>`;
    }
  }

  const message = {
    channel: "C07U1GHS1R9",
    text: `Hi <@U081UEASH37> <@U07UY3M1TF0> <@U08U4NPLXN0>  - New arrival/departure action item for ${
      actionItem.guest_name || "N/A"
    }`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Hi <@U081UEASH37> <@U07UY3M1TF0> <@U08U4NPLXN0>\n\n*🏠 Property:* ${
            actionItem.property_name || "N/A"
          }\n*👤 Guest:* ${
            actionItem.guest_name || "N/A"
          }${dateInfo}\n*📝 Description:* ${(actionItem.item || "N/A").replace(
            /\n/g,
            " "
          )}\n*🏷️ Category:* ${actionItem.category || "N/A"}${hospitableLink}`,
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

async function scheduleNegativeSentimentReminder(
  actionItem,
  reservationData,
  env
) {
  try {
    // Format dates for the message
    function formatWithOffset(isoString) {
      if (!isoString) return "N/A";
      const d = new Date(isoString);
      const match = isoString.match(/([+-]\d{2}:\d{2})$/);
      const offset = match ? `UTC${match[1]}` : "";
      return (
        d.toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        }) + (offset ? ` (${offset})` : "")
      );
    }

    const checkIn = formatWithOffset(reservationData.check_in);
    const checkOut = formatWithOffset(reservationData.check_out);
    const stayInfo = `${checkIn} ---> ${checkOut}`;

    const hospitableLink = reservationData.conversation_id
      ? `https://my.hospitable.com/inbox/thread/${reservationData.conversation_id}`
      : "N/A";

    // Get checkout timestamp for scheduling + 30 minutes buffer
    const checkoutDate = new Date(reservationData.check_out);
    checkoutDate.setMinutes(checkoutDate.getMinutes() + 30);
    const postAt = Math.floor(checkoutDate.getTime() / 1000);

    const message = {
      channel: "C04SDEC0UHZ",
      text: `💥 Turn off reviewing the guest`,
      post_at: postAt,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `💥 *Turn off reviewing the guest*\n\nThe automation that gives review to the guest. Turn that off. Not the message.\n\n*🏠 Property:* ${
              actionItem.property_name || "N/A"
            }\n*👤 Guest:* ${
              actionItem.guest_name || "N/A"
            }\n*:date: Stay:* ${stayInfo}\n\n<${hospitableLink}|View in Hospitable>`,
          },
        },
      ],
    };

    console.log("Scheduling negative sentiment reminder:", message);
    const response = await fetch("https://slack.com/api/chat.scheduleMessage", {
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
        `Error scheduling message: ${response.status} - ${errorText}`
      );
    } else {
      const result = await response.json();
      console.log("Scheduled message result:", result);
    }
  } catch (error) {
    console.error("Error scheduling negative sentiment reminder:", error);
  }
}

async function sendNegativeSentimentFailsafe(actionItem, env) {
  try {
    const message = {
      channel: "C04SDEC0UHZ",
      text: `⚠️ Negative sentiment detected but reservation data unavailable`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `⚠️ <@U03S5GQ2CDP> *Negative sentiment detected but reservation data unavailable*\n\n*🏠 Property:* ${
              actionItem.property_name || "N/A"
            }\n*👤 Guest:* ${
              actionItem.guest_name || "N/A"
            }\n*📝 Description:* ${(actionItem.item || "N/A").replace(
              /\n/g,
              " "
            )}\n\nCould not fetch reservation data from Hospitable API. Please manually check and schedule review reminder.`,
          },
        },
      ],
    };

    console.log("Sending negative sentiment failsafe:", message);
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
        `Error sending failsafe message: ${response.status} - ${errorText}`
      );
    }
  } catch (error) {
    console.error("Error sending negative sentiment failsafe:", error);
  }
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

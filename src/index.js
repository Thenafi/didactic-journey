export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle webhook endpoint
    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleHostbuddyWebhook(request, env);
    }

    // Handle A008-specific webhook endpoint (only process negative-sentiment -> schedule reminder)
    if (url.pathname === "/a008" && request.method === "POST") {
      return handleA008Webhook(request, env);
    }

    // Handle Slack interactive components (button clicks)
    if (url.pathname === "/slack/interactive" && request.method === "POST") {
      return handleSlackInteraction(request, env, ctx);
    }

    // Handle scheduled messages query
    if (url.pathname === "/scheduled-messages" && request.method === "GET") {
      return getScheduledMessages(env);
    }

    // Handle test search route
    if (url.pathname === "/test-search" && request.method === "GET") {
      return testSlackSearch(env, request);
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

// A008-specific webhook handler: only detect negative sentiment items and schedule reminders
async function handleA008Webhook(request, env) {
  try {
    const payload = await request.json();

    if (!payload.action_items || !Array.isArray(payload.action_items)) {
      console.log("A008 webhook received with no action_items");
      return new Response("OK", { status: 200 });
    }

    for (let i = 0; i < payload.action_items.length; i++) {
      const item = payload.action_items[i];
      try {
        // Only act on items for property A008 (property_name contains "A008")
        const isA008 =
          item.property_name &&
          item.property_name.toString().toUpperCase().includes("A008");

        if (!isA008) {
          continue;
        }

        // Detect negative sentiment phrasing
        const isSentimentNegative =
          item.item &&
          item.item.toLowerCase().includes("sentiment turned negative");

        if (!isSentimentNegative) {
          continue;
        }

        // Fetch reservation data if available
        let reservationData = null;
        if (item.hospitable_reservation_id) {
          reservationData = await fetchReservationData(
            item.hospitable_reservation_id,
            env
          );
        }

        if (reservationData && reservationData.check_out) {
          await scheduleNegativeSentimentReminder(item, reservationData, env);
        } else {
          // fallback: notify via failsafe
          await sendNegativeSentimentFailsafe(item, env);
        }

        // small delay to avoid rate limits
        if (i < payload.action_items.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (err) {
        console.error("Error processing A008 action item:", err);
      }
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("Error processing A008 webhook:", error);
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
  // Check for ADDRESS-REQUEST on A044 property
  const isAddressRequestA044 =
    actionItem.category === "ADDRESS-REQUEST" &&
    actionItem.property_name?.toString().toLowerCase().includes("a044");

  if (isAddressRequestA044) {
    await sendAddressRequestAlert(env);
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

async function sendAddressRequestAlert(env) {
  const message = {
    channel: "C04SDEC0UHZ", // #automation channel
    text: "🚨 Please do not share the unit number before check-in",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "🚨 *ALERT: Address Request for A044*\n\nPlease do not share the unit number before check-in.",
        },
      },
    ],
  };

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });
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

  // Try to post in thread if check-in date is available
  let threadTs = null;
  if (reservationData && reservationData.check_in) {
    try {
      threadTs = await findOrCreateWeekThread(reservationData.check_in, env);
    } catch (error) {
      console.error(
        "Error finding/creating thread, posting to main channel:",
        error
      );
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

  // Add thread_ts if we have a thread
  if (threadTs) {
    message.thread_ts = threadTs;
  }

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

async function findOrCreateWeekThread(checkInISO, env) {
  // Calculate the Saturday for this check-in date in LA timezone
  const weekString = getWeekString(checkInISO);

  console.log(`Looking for week thread: ${weekString}`);

  // Search for existing thread with this week string
  const searchUrl = new URL("https://slack.com/api/search.messages");
  searchUrl.searchParams.append(
    "query",
    `in:#a044-eileena-aria "${weekString}"`
  );
  searchUrl.searchParams.append("count", "20");

  const searchResponse = await fetch(searchUrl.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.USER_OAUTH_TOKEN}`,
    },
  });

  if (!searchResponse.ok) {
    console.error("Search API error:", searchResponse.status);
    throw new Error("Failed to search for existing thread");
  }

  const searchData = await searchResponse.json();

  if (searchData.ok && searchData.messages?.matches) {
    // Filter for parent messages only (not replies in threads)
    const parentMessages = searchData.messages.matches.filter(
      (msg) => !msg.thread_ts || msg.thread_ts === msg.ts
    );

    if (parentMessages.length > 0) {
      // Found existing thread, use the first one
      console.log(`Found existing thread: ${parentMessages[0].ts}`);
      return parentMessages[0].ts;
    }
  }

  // No thread found, create a new one
  console.log(`Creating new thread for week: ${weekString}`);
  return await createWeekThread(weekString, env);
}

function getWeekString(checkInISO) {
  // Parse check-in date and convert to LA timezone
  const checkInDate = new Date(checkInISO);

  // Get LA timezone offset (PST is UTC-8, PDT is UTC-7)
  // We'll use a simple approach: format the date in LA timezone
  const laDateString = checkInDate.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });

  // Parse the LA date to get year, month, day
  const [weekday, dateStr, timeStr] = laDateString.split(", ");
  const [month, day, year] = dateStr.split("/");

  // Create a date object for LA timezone
  const laDate = new Date(year, parseInt(month) - 1, parseInt(day));

  // Calculate Saturday of that week (0 = Sunday, 6 = Saturday)
  const dayOfWeek = laDate.getDay();
  const daysUntilSaturday = (6 - dayOfWeek + 7) % 7; // Days until next Saturday
  const daysSinceSaturday = (dayOfWeek + 1) % 7; // Days since last Saturday

  // Get the Saturday on or before check-in date
  const saturday = new Date(laDate);
  if (dayOfWeek === 6) {
    // It's Saturday, use this date
  } else {
    // Go back to previous Saturday
    saturday.setDate(saturday.getDate() - daysSinceSaturday);
  }

  // Format as Week_Sat_16th_Nov_2025
  const satDay = saturday.getDate();
  const satMonth = saturday.toLocaleString("en-US", { month: "short" });
  const satYear = saturday.getFullYear();

  // Get ordinal suffix (1st, 2nd, 3rd, 4th, etc.)
  const ordinal = getOrdinalSuffix(satDay);

  return `Week_Sat_${satDay}${ordinal}_${satMonth}_${satYear}`;
}

function getOrdinalSuffix(day) {
  if (day > 3 && day < 21) return "th";
  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

async function createWeekThread(weekString, env) {
  const message = {
    channel: "C07U1GHS1R9",
    text: `📅 ${weekString}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `📅 ${weekString}`,
          emoji: true,
        },
      },
    ],
  };

  console.log("Creating new week thread:", message);
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
      `Error creating week thread: ${response.status} - ${errorText}`
    );
    throw new Error("Failed to create week thread");
  }

  const result = await response.json();

  if (!result.ok) {
    console.error("Failed to create week thread:", result.error);
    throw new Error("Failed to create week thread");
  }

  console.log(`Created new thread with ts: ${result.ts}`);
  return result.ts;
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

    // Only schedule for Airbnb platform
    const platform = reservationData.platform
      ? reservationData.platform.toLowerCase()
      : "";
    if (platform !== "airbnb") {
      console.log(
        `Platform is ${
          reservationData.platform || "unknown"
        }, not Airbnb. Skipping scheduled reminder.`
      );
      return;
    }

    // Get checkout timestamp for scheduling with random 6-8 hour buffer
    const checkoutDate = new Date(reservationData.check_out);
    // Generate random hours between 6 and 8 (360-480 minutes)
    const randomMinutes = Math.floor(Math.random() * 121) + 360; // 360 + (0-120) = 360-480 minutes
    checkoutDate.setMinutes(checkoutDate.getMinutes() + randomMinutes);
    const postAt = Math.floor(checkoutDate.getTime() / 1000);

    console.log(
      `Scheduling reminder ${Math.floor(randomMinutes / 60)} hours and ${
        randomMinutes % 60
      } minutes after checkout`
    );

    // Validate scheduling constraints
    const now = Math.floor(Date.now() / 1000);
    const maxFutureTime = now + 120 * 24 * 60 * 60; // 120 days in seconds

    // Check if checkout date is in the past
    if (postAt <= now) {
      console.log(
        "Checkout date is in the past, sending message immediately instead of scheduling"
      );
      await sendImmediateNegativeSentimentReminder(
        actionItem,
        reservationData,
        stayInfo,
        hospitableLink,
        env
      );
      return;
    }

    // Check if checkout date is more than 120 days in the future
    if (postAt > maxFutureTime) {
      console.log(
        "Checkout date is more than 120 days in the future, cannot schedule. Notifying via immediate message."
      );
      await sendSchedulingLimitExceeded(
        actionItem,
        reservationData,
        stayInfo,
        hospitableLink,
        env
      );
      return;
    }

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

    const result = await response.json();

    if (!response.ok || !result.ok) {
      const errorText = result.error || (await response.text());
      console.error(
        `Error scheduling message: ${response.status} - ${errorText}`
      );

      // Handle specific Slack errors
      if (result.error === "time_too_far" || result.error === "time_in_past") {
        console.log(
          "Slack scheduling error, sending immediate notification instead"
        );
        await sendImmediateNegativeSentimentReminder(
          actionItem,
          reservationData,
          stayInfo,
          hospitableLink,
          env
        );
      } else if (result.error === "restricted_too_many") {
        console.log("Rate limit exceeded for scheduled messages");
        // Wait and retry or send immediate notification
        await sendImmediateNegativeSentimentReminder(
          actionItem,
          reservationData,
          stayInfo,
          hospitableLink,
          env
        );
      }
    } else {
      console.log("Scheduled message result:", result);
    }
  } catch (error) {
    console.error("Error scheduling negative sentiment reminder:", error);
  }
}
async function sendImmediateNegativeSentimentReminder(
  actionItem,
  reservationData,
  stayInfo,
  hospitableLink,
  env
) {
  try {
    const message = {
      channel: "C04SDEC0UHZ",
      text: `💥 Turn off reviewing the guest (IMMEDIATE)`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `💥 *Turn off reviewing the guest NOW*\n\n⚠️ Checkout has already passed or is imminent.\n\nThe automation that gives review to the guest. Turn that off. Not the message.\n\n*🏠 Property:* ${
              actionItem.property_name || "N/A"
            }\n*👤 Guest:* ${
              actionItem.guest_name || "N/A"
            }\n*:date: Stay:* ${stayInfo}\n\n<${hospitableLink}|View in Hospitable>`,
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
        `Error sending immediate reminder: ${response.status} - ${errorText}`
      );
    }
  } catch (error) {
    console.error(
      "Error sending immediate negative sentiment reminder:",
      error
    );
  }
}

async function sendSchedulingLimitExceeded(
  actionItem,
  reservationData,
  stayInfo,
  hospitableLink,
  env
) {
  try {
    const message = {
      channel: "C04SDEC0UHZ",
      text: `⚠️ Cannot schedule reminder - checkout too far in future`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `⚠️ <@U03S5GQ2CDP> *Cannot schedule reminder - checkout is more than 120 days away*\n\n💥 Remember to turn off reviewing this guest closer to checkout.\n\nThe automation that gives review to the guest. Turn that off. Not the message.\n\n*🏠 Property:* ${
              actionItem.property_name || "N/A"
            }\n*👤 Guest:* ${
              actionItem.guest_name || "N/A"
            }\n*:date: Stay:* ${stayInfo}\n\n<${hospitableLink}|View in Hospitable>`,
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
        `Error sending limit exceeded message: ${response.status} - ${errorText}`
      );
    }
  } catch (error) {
    console.error("Error sending scheduling limit exceeded message:", error);
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

async function getScheduledMessages(env) {
  try {
    // Get list of scheduled messages
    const response = await fetch(
      "https://slack.com/api/chat.scheduledMessages.list",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: "C04SDEC0UHZ", // The channel where negative sentiment reminders are scheduled
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return new Response(
        JSON.stringify({
          error: `Slack API error: ${response.status} - ${errorText}`,
        }),
        {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const data = await response.json();

    if (!data.ok) {
      return new Response(JSON.stringify({ error: data.error }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Format the response
    const scheduledMessages = data.scheduled_messages || [];
    const formattedMessages = scheduledMessages.map((msg) => ({
      id: msg.id,
      channel_id: msg.channel_id,
      post_at: msg.post_at,
      post_at_readable: new Date(msg.post_at * 1000).toISOString(),
      text: msg.text,
      blocks: msg.blocks,
      attachments: msg.attachments,
      date_created: msg.date_created,
      date_created_readable: new Date(msg.date_created * 1000).toISOString(),
    }));

    return new Response(
      JSON.stringify(
        {
          ok: true,
          count: formattedMessages.length,
          scheduled_messages: formattedMessages,
        },
        null,
        2
      ),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error fetching scheduled messages:", error);
    return new Response(
      JSON.stringify({
        error: "Internal Server Error",
        details: error.message,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

async function testSlackSearch(env, request) {
  try {
    // Get query parameter from request URL, or use default
    const requestUrl = new URL(request.url);
    const searchQuery =
      requestUrl.searchParams.get("q") ||
      'in:#a044-eileena-aria "ARRIVAL-DEPARTURE"';

    // Build query URL with parameters
    const searchUrl = new URL("https://slack.com/api/search.messages");
    searchUrl.searchParams.append("query", searchQuery);
    searchUrl.searchParams.append("count", "10");

    const searchResponse = await fetch(searchUrl.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.USER_OAUTH_TOKEN}`,
      },
    });

    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();
      return new Response(
        JSON.stringify({
          error: `Slack API error: ${searchResponse.status} - ${errorText}`,
        }),
        {
          status: searchResponse.status,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const data = await searchResponse.json();

    // Return raw response
    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error testing Slack search:", error);
    return new Response(
      JSON.stringify({
        error: "Internal Server Error",
        details: error.message,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

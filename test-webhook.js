// Test script to simulate a Hostbuddy webhook
// Run with: node test-webhook.js

const testPayload = {
  action_items: [
    {
      user_id: "castlehost99_gmail_com",
      property_name: "Paramount 3911 |A033_Aurora",
      guest_name: "Faisal null",
      item: "HostBuddy has stopped responding to this guest because their sentiment turned negative.",
      category: "OTHER",
      created_at_utc: "2025-08-25T05:59:27Z",
      id: "8060b15cda4c",
      status: "incomplete",
      reservation_id: "c17f36a2-9327-4bf6-87df-1317e0a4df0d",
      conversation_id: "c17f36a2-9327-4bf6-87df-1317e0a4df0d",
      hospitable_reservation_id: "c17f36a2-9327-4bf6-87df-1317e0a4df0d",
    },
    {
      user_id: "castlehost99_gmail_com",
      property_name: "Downtown Loft |B055_Portland",
      guest_name: "Sarah Johnson",
      item: "Guest reported issue with WiFi connectivity in the unit.",
      category: "MAINTENANCE",
      created_at_utc: "2025-08-25T06:15:33Z",
      id: "9171c26eeb5d",
      status: "incomplete",
      reservation_id: "d28g47b3-0438-5cg7-98ef-2428f1b5e5e1",
      conversation_id: "d28g47b3-0438-5cg7-98ef-2428f1b5e5e1",
      hospitable_reservation_id: "d28g47b3-0438-5cg7-98ef-2428f1b5e5e1",
    },
  ],
  hook_id: "5aa4c04e-d8e7-4a99-86d1-9a683e661a6e",
};

async function testWebhook() {
  // Replace with your actual worker URL
  // const workerUrl = "http://localhost:8787/webhook"; // For local testing
  const workerUrl =
    "https://hostbuddy-slack-integration.chest.workers.dev/webhook"; // For production

  try {
    const response = await fetch(workerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(testPayload),
    });

    console.log("Response Status:", response.status);
    console.log("Response Text:", await response.text());

    if (response.ok) {
      console.log("✅ Webhook test successful!");
    } else {
      console.log("❌ Webhook test failed");
    }
  } catch (error) {
    console.error("Error testing webhook:", error);
  }
}

testWebhook();

// Test script to simulate a Hostbuddy webhook
// Run with: node test-webhook.js

const testPayload = {
  action_items: [
    {
      user_id: "castlehost99_gmail_com",
      property_name: "642 ThePark | A044_EA",
      guest_name: "Jeklin Kim",
      item: "The guest requested early check-in between 12 noon and 1 pm; team needs to check with cleaners and confirm availability.",
      category: "GUEST REQUESTS",
      created_at_utc: "2025-10-12T14:19:42Z",
      id: "cd2eaeb8f1e8",
      status: "incomplete",
      reservation_id: "77adeb86-0029-48f0-b786-675313dbef33",
      conversation_id: "77adeb86-0029-48f0-b786-675313dbef33",
      hospitable_reservation_id: "77adeb86-0029-48f0-b786-675313dbef33",
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


async function shortenUrl(url) {
  try {
    const response = await fetch(
      `https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`
    );
    if (response.ok) {
      return await response.text();
    }
    return url;
  } catch (error) {
    console.error("Error shortening URL:", error);
    return url;
  }
}

async function test() {
  const longUrl = "https://my.hospitable.com/inbox/thread/1234567890";
  console.log(`Shortening ${longUrl}...`);
  const shortUrl = await shortenUrl(longUrl);
  console.log(`Result: ${shortUrl}`);
  
  if (shortUrl.startsWith("https://is.gd/")) {
      console.log("✅ SUCCESS: URL shortened correctly");
  } else {
      console.log("❌ FAILURE: URL not shortened");
  }
}

test();

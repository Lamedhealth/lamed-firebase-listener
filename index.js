// index.js
const admin = require("firebase-admin");
const fetch = require("node-fetch"); // Cloudflare Worker calls
const { getDatabase } = require("firebase-admin/database");
const http = require("http");

// ----------------------------
// 1️⃣ Firebase Admin Init using ENV variable
// ----------------------------
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT env variable not set!");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://lamedtelemedicine-default-rtdb.europe-west1.firebasedatabase.app/",
});

const db = getDatabase();
const WORKER_URL = "https://lamed-notifierr.medatesfe21.workers.dev";

// ----------------------------
// 2️⃣ Helper: Send notification via Worker
// ----------------------------
const sendNotificationViaWorker = async (playerId, title, message) => {
  if (!playerId) return;
  try {
    const response = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId, title, body: message }),
    });
    const result = await response.json();
    console.log(`✅ Notification sent to ${playerId}:`, result);
  } catch (error) {
    console.error("❌ Error sending notification via worker:", error);
  }
};

// ----------------------------
// 3️⃣ Helper: Get Player ID from Firebase
// ----------------------------
const getPlayerId = async (userId) => {
  if (!userId) return null;
  try {
    const snap = await db.ref(`/users/${userId}/oneSignalPlayerId`).once("value");
    const playerId = snap.val();
    if (!playerId) console.warn(`⚠️ No Player ID found for user ${userId}`);
    return playerId;
  } catch (e) {
    console.error(`❌ Error fetching Player ID for user ${userId}:`, e);
    return null;
  }
};

// ----------------------------
// 4️⃣ Helper: Notify user
// ----------------------------
const notifyUser = async (userId, title, message) => {
  const playerId = await getPlayerId(userId);
  if (!playerId) return;
  await sendNotificationViaWorker(playerId, title, message);
};

// ----------------------------
// 5️⃣ Firebase Listeners
// ----------------------------
const createChildAddedListener = (ref, callback) => {
  let loaded = false;
  ref.once("value", () => (loaded = true));
  ref.on("child_added", async (snapshot) => {
    if (!loaded) return; // ignore old data
    const data = snapshot.val();
    if (!data) return;
    await callback(data);
  });
};

// Appointments
createChildAddedListener(db.ref("/appointments"), async (appointment) => {
  if (appointment.doctorId) {
    await notifyUser(
      appointment.doctorId,
      "🩺 New Appointment Booked",
      `${appointment.patientName} booked a session with you.`
    );
  }
  if (appointment.patientId) {
    await notifyUser(
      appointment.patientId,
      "📅 Appointment Scheduled",
      `Your appointment with Dr. ${appointment.doctorName} is scheduled.`
    );
  }
});

// Prescriptions
createChildAddedListener(db.ref("/prescriptions"), async (prescription) => {
  if (!prescription || !prescription.patientId) return;
  await notifyUser(
    prescription.patientId,
    "💊 New Prescription",
    `Dr. ${prescription.doctorName} uploaded a new prescription for you.`
  );
});

// Chat Messages
createChildAddedListener(db.ref("/chats"), async (chatSnapshot) => {
  for (const msgId in chatSnapshot) {
    const message = chatSnapshot[msgId];
    if (!message || !message.toUserId) continue;

    let text = message.text || "";
    if (message.fileUrl) text = "📎 Sent you a new file";

    await notifyUser(message.toUserId, "💬 New Message", text);
  }
});

// Lab Results
createChildAddedListener(db.ref("/lab_requests"), async (lab) => {
  if (!lab || !lab.patientId) return;
  await notifyUser(
    lab.patientId,
    "🧪 New Lab Result",
    `Dr. ${lab.doctorName} uploaded a new lab result for you.`
  );
});

// Payment Updates
let paymentsLoaded = false;
db.ref("/payments").once("value", () => (paymentsLoaded = true));
db.ref("/payments").on("child_changed", async (snapshot) => {
  if (!paymentsLoaded) return;
  const payment = snapshot.val();
  if (!payment || !payment.patientId) return;

  await notifyUser(
    payment.patientId,
    "💰 Payment Update",
    `Your payment status is now ${payment.status || "updated"}.`
  );
});

// ----------------------------
// 6️⃣ Minimal HTTP server for Render free Web Service
// ----------------------------
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Firebase listener is running.\n");
  })
  .listen(PORT, () => console.log(`🌐 Web service listening on port ${PORT}`));

console.log("👂 Listening to Firebase Realtime Database...");

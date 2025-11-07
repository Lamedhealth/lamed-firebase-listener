const admin = require("firebase-admin");
const fetch = require("node-fetch"); // For Cloudflare Worker calls
const { getDatabase } = require("firebase-admin/database");
const http = require("http"); // Minimal HTTP server for Render

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
// 2️⃣ Helper to send notifications via Worker
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
// 3️⃣ Firebase Realtime Listeners
// ----------------------------

const createChildAddedListener = (ref, callback) => {
  let loaded = false;
  ref.once("value", () => (loaded = true));
  ref.on("child_added", async (snapshot) => {
    if (!loaded) return; // Ignore historical data
    const data = snapshot.val();
    if (!data) return;
    await callback(data);
  });
};

// Appointments
createChildAddedListener(db.ref("/appointments"), async (appointment) => {
  if (appointment.doctorId) {
    const snap = await db.ref(`/users/${appointment.doctorId}/oneSignalPlayerId`).once("value");
    const playerId = snap.val();
    if (playerId) {
      await sendNotificationViaWorker(
        playerId,
        "🩺 New Appointment Booked",
        `${appointment.patientName} booked a session with you.`
      );
    }
  }
  if (appointment.patientId) {
    const snap = await db.ref(`/users/${appointment.patientId}/oneSignalPlayerId`).once("value");
    const playerId = snap.val();
    if (playerId) {
      await sendNotificationViaWorker(
        playerId,
        "📅 Appointment Scheduled",
        `Your appointment with Dr. ${appointment.doctorName} is scheduled.`
      );
    }
  }
});

// Prescriptions
createChildAddedListener(db.ref("/prescriptions"), async (prescription) => {
  if (!prescription || !prescription.patientId) return;
  const snap = await db.ref(`/users/${prescription.patientId}/oneSignalPlayerId`).once("value");
  const playerId = snap.val();
  if (playerId) {
    await sendNotificationViaWorker(
      playerId,
      "💊 New Prescription",
      `Dr. ${prescription.doctorName} uploaded a new prescription for you.`
    );
  }
});

// Chat Messages
createChildAddedListener(db.ref("/chats"), async (chatSnapshot) => {
  for (const msgId in chatSnapshot) {
    const message = chatSnapshot[msgId];
    if (!message || !message.toUserId) continue;
    const snap = await db.ref(`/users/${message.toUserId}/oneSignalPlayerId`).once("value");
    const playerId = snap.val();
    if (playerId) {
      let text = message.text || "";
      if (message.fileUrl) text = "📎 Sent you a new file";
      await sendNotificationViaWorker(playerId, "💬 New Message", text);
    }
  }
});

// Lab Results
createChildAddedListener(db.ref("/lab_requests"), async (lab) => {
  if (!lab || !lab.patientId) return;
  const snap = await db.ref(`/users/${lab.patientId}/oneSignalPlayerId`).once("value");
  const playerId = snap.val();
  if (playerId) {
    await sendNotificationViaWorker(
      playerId,
      "🧪 New Lab Result",
      `Dr. ${lab.doctorName} uploaded a new lab result for you.`
    );
  }
});

// Payment Updates
let paymentsLoaded = false;
db.ref("/payments").once("value", () => (paymentsLoaded = true));
db.ref("/payments").on("child_changed", async (snapshot) => {
  if (!paymentsLoaded) return;
  const payment = snapshot.val();
  if (!payment || !payment.patientId) return;
  const snap = await db.ref(`/users/${payment.patientId}/oneSignalPlayerId`).once("value");
  const playerId = snap.val();
  if (playerId) {
    await sendNotificationViaWorker(
      playerId,
      "💰 Payment Update",
      `Your payment status is now ${payment.status || "updated"}.`
    );
  }
});

// ----------------------------
// 4️⃣ Minimal HTTP server for Render free Web Service
// ----------------------------
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Firebase listener is running.\n");
  })
  .listen(PORT, () => console.log(`🌐 Web service listening on port ${PORT}`));

console.log("👂 Listening to Firebase Realtime Database...");

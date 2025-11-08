const admin = require("firebase-admin");
const fetch = require("node-fetch"); // Cloudflare Worker calls
const { getDatabase, ServerValue } = require("firebase-admin/database");
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
  databaseURL:
    "https://lamedtelemedicine-default-rtdb.europe-west1.firebasedatabase.app/",
});

const db = getDatabase();
const WORKER_URL = "https://lamed-notifierr.medatesfe21.workers.dev";

// ----------------------------
// 2️⃣ Helper: Send notification via Worker
// ----------------------------
const sendNotificationViaWorker = async (playerId, title, message) => {
  if (!playerId) {
    console.warn("⚠️ No playerId provided, skipping notification");
    return;
  }

  const payload = { playerId, title, body: message };
  console.log("🔹 Sending payload to worker:", payload);

  try {
    const response = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
    const data = snapshot.val();
    if (!data) return;
    if (!loaded) {
      console.log("⚠️ Ignoring old data on startup");
      return;
    }
    await callback(data, snapshot.key);
  });
};

// ----------------------------
// Appointments
// ----------------------------
createChildAddedListener(db.ref("/appointments"), async (appointment) => {
  const patientName = appointment.patientName || "Patient";
  const doctorName = appointment.doctorName || "Doctor";

  if (appointment.doctorId)
    await notifyUser(
      appointment.doctorId,
      "🩺 New Appointment Booked",
      `${patientName} booked a session with you.`
    );

  if (appointment.patientId)
    await notifyUser(
      appointment.patientId,
      "📅 Appointment Scheduled",
      `Your appointment with Dr. ${doctorName} is scheduled.`
    );
});

// ----------------------------
// Prescriptions (per user path)
// ----------------------------
db.ref("/patient_files").on("child_added", (userSnap) => {
  const userId = userSnap.key;
  db.ref(`/patient_files/${userId}/prescriptions`).on("child_added", async (presSnap) => {
    const presc = presSnap.val();
    if (!presc) return;
    await notifyUser(
      userId,
      "💊 New Prescription",
      `Dr. ${presc.Doctor || "Doctor"} uploaded a new prescription for you.`
    );
  });
});

// ----------------------------
// Lab Requests (per user path)
// ----------------------------
db.ref("/patient_files").on("child_added", (userSnap) => {
  const userId = userSnap.key;
  db.ref(`/patient_files/${userId}/lab_requests`).on("child_added", async (labSnap) => {
    const lab = labSnap.val();
    if (!lab) return;
    await notifyUser(
      userId,
      "🧪 New Lab Result",
      `Dr. ${lab.Doctor || "Doctor"} uploaded a new lab result for you.`
    );
  });
});

// ----------------------------
// Chat Messages
// ----------------------------
db.ref("/chats").on("child_added", (chatSnap) => {
  const chatId = chatSnap.key;
  db.ref(`/chats/${chatId}/messages`).on("child_added", async (msgSnap) => {
    const msg = msgSnap.val();
    if (!msg || !msg.toUserId) return;

    let text = msg.text || "";
    if (msg.fileUrl) text = "📎 Sent you a new file";

    await notifyUser(msg.toUserId, "💬 New Message", text);
  });
});

// ----------------------------
// Payment Updates
// ----------------------------
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

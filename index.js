// index.js
const admin = require("firebase-admin");
const fetch = require("node-fetch"); // Needed for Cloudflare Worker
const { getDatabase } = require("firebase-admin/database");

// ------------------------
// ⚡ Firebase Admin Init via Env Vars
// ------------------------
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
const databaseURL = process.env.FIREBASE_DATABASE_URL;

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL,
});

const db = getDatabase();

// ------------------------
// 🔔 Cloudflare Worker URL
// ------------------------
const WORKER_URL = process.env.WORKER_URL;

// ------------------------
// Helper: Send notification via Worker
// ------------------------
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

// ------------------------
// ✅ Utility to ignore old data
// ------------------------
const createChildListener = (ref, callback) => {
  let loaded = false;
  ref.once("value", () => {
    loaded = true;
  });

  ref.on("child_added", async (snapshot) => {
    if (!loaded) return; // Ignore old data
    await callback(snapshot);
  });
};

const createChildChangedListener = (ref, callback) => {
  let loaded = false;
  ref.once("value", () => {
    loaded = true;
  });

  ref.on("child_changed", async (snapshot) => {
    if (!loaded) return;
    await callback(snapshot);
  });
};

// ------------------------
// 1️⃣ Appointments
// ------------------------
createChildListener(db.ref("/appointments"), async (snapshot) => {
  const appointment = snapshot.val();
  if (!appointment) return;

  // Notify doctor
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

  // Notify patient
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

// ------------------------
// 2️⃣ Prescriptions
// ------------------------
createChildListener(db.ref("/prescriptions"), async (snapshot) => {
  const prescription = snapshot.val();
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

// ------------------------
// 3️⃣ Chat Messages
// ------------------------
createChildListener(db.ref("/chats"), async (snapshot) => {
  snapshot.forEach(async (msgSnap) => {
    const message = msgSnap.val();
    if (!message || !message.toUserId) return;

    const snap = await db.ref(`/users/${message.toUserId}/oneSignalPlayerId`).once("value");
    const playerId = snap.val();
    if (!playerId) return;

    let text = message.text || "";
    if (message.fileUrl) text = "📎 Sent you a new file";

    await sendNotificationViaWorker(playerId, "💬 New Message", text);
  });
});

// ------------------------
// 4️⃣ Lab Results
// ------------------------
createChildListener(db.ref("/lab_requests"), async (snapshot) => {
  const lab = snapshot.val();
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

// ------------------------
// 5️⃣ Payment Updates
// ------------------------
createChildChangedListener(db.ref("/payments"), async (snapshot) => {
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

console.log("👂 Listening to Firebase Realtime Database...");

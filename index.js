// index.js
const admin = require("firebase-admin");
const fetch = require("node-fetch"); // Needed for Cloudflare Worker call
const { getDatabase } = require("firebase-admin/database");

// Initialize Firebase Admin SDK
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://lamedtelemedicine-default-rtdb.europe-west1.firebasedatabase.app/",
});

const db = getDatabase();
const WORKER_URL = "https://lamed-notifierr.medatesfe21.workers.dev";

// ✅ Helper: Send notification via Cloudflare Worker
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

// -----------------------------------------
// 1️⃣ Appointments
// -----------------------------------------
const appointmentsRef = db.ref("/appointments");
let appointmentsLoaded = false;

appointmentsRef.once("value", () => {
  appointmentsLoaded = true;
});

appointmentsRef.on("child_added", async (snapshot) => {
  if (!appointmentsLoaded) return; // 🚫 Ignore old data

  const appointment = snapshot.val();
  if (!appointment) return;

  // 🧑‍⚕️ Notify doctor
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

  // 🧍‍♀️ Notify patient
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

// -----------------------------------------
// 2️⃣ Prescriptions
// -----------------------------------------
const prescriptionsRef = db.ref("/prescriptions");
let prescriptionsLoaded = false;

prescriptionsRef.once("value", () => {
  prescriptionsLoaded = true;
});

prescriptionsRef.on("child_added", async (snapshot) => {
  if (!prescriptionsLoaded) return;

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

// -----------------------------------------
// 3️⃣ Chat Messages
// -----------------------------------------
const chatsRef = db.ref("/chats");
let chatsLoaded = false;

chatsRef.once("value", () => {
  chatsLoaded = true;
});

chatsRef.on("child_changed", async (snapshot) => {
  if (!chatsLoaded) return;

  snapshot.forEach(async (msgSnap) => {
    const message = msgSnap.val();
    if (!message || !message.toUserId) return;

    const snap = await db.ref(`/users/${message.toUserId}/oneSignalPlayerId`).once("value");
    const playerId = snap.val();

    if (playerId) {
      let text = message.text || "";
      if (message.fileUrl) text = "📎 Sent you a new file";

      await sendNotificationViaWorker(playerId, "💬 New Message", text);
    }
  });
});

// -----------------------------------------
// 4️⃣ Lab Results
// -----------------------------------------
const labRef = db.ref("/lab_requests");
let labsLoaded = false;

labRef.once("value", () => {
  labsLoaded = true;
});

labRef.on("child_added", async (snapshot) => {
  if (!labsLoaded) return;

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

// -----------------------------------------
// 5️⃣ Payment Updates
// -----------------------------------------
const paymentsRef = db.ref("/payments");
let paymentsLoaded = false;

paymentsRef.once("value", () => {
  paymentsLoaded = true;
});

paymentsRef.on("child_changed", async (snapshot) => {
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

// -----------------------------------------
console.log("👂 Listening to Firebase Realtime Database...");
